import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prepareFile } from "../../scripts/ci/prepare.mjs";
import {
  authorizedPrincipal,
  createBackendWorkerDrivers,
  createBackendController,
  ensureInstallation,
  requiresPostgres,
} from "./postgres-backend-state.mjs";
import { waitFor } from "./wait-for.mjs";
import { socketDirectory } from "./socket-directory.mjs";
import {
  loadNativeRepositoryAccess,
  installationDriverConfigurations,
} from "../../apps/controller/src/composition/installation-config.ts";
import { freezeAgentRevision } from "../../packages/contracts/src/index.ts";

export const CREDENTIAL_GATEWAY_FIXTURE_ID = "credential-gateway-worker-fixture";

async function repositoryWorkerFixture(context, driver, namespaceId) {
  const directory = await socketDirectory(context, "worker-repository-");
  const registryPath = join(directory, "registry.json");
  const publicCaPath = join(directory, "ca.pem");
  const controlSocket = join(directory, "control.sock");
  await writeFile(publicCaPath, rootCertificates[0], { mode: 0o600 });
  const backend = { id: driver.backendId, type: "github", configuration: { registryPath } };

  async function load() {
    const selection = {
      id: driver.id,
      implementation: driver.implementation,
      configuration: { sessionDurationSeconds: driver.sessionDurationSeconds },
    };
    const registry = {
      ...driver.registry,
      repositories: driver.registry.repositories.map((repository) => ({
        ...repository,
        namespaces: [{ namespaceId, profiles: ["git-read"] }],
      })),
    };
    await writeFile(registryPath, JSON.stringify(registry), { mode: 0o600 });
    const access = await loadNativeRepositoryAccess(
      { backend, selection },
      { controlSocket, publicCaPath },
      { custodyKeyPath: join(directory, "custody"), privateKeyPath: join(directory, "signer") },
    );
    return { access, selection };
  }

  const { access } = await load();
  driver.bindSnapshot(access.repositoryAdmission.policy, namespaceId);
  return {
    backend,
    admission: access.repositoryAdmission,
    async worker(computeDriver) {
      const { access, selection } = await load();
      const repositoryRuntime = access.bindCompute(computeDriver);
      // Exercise the real startup and lifecycle with synthetic operations on its selected sender.
      // The fixture's PostgreSQL receipt store retains sessions between Worker instances.
      const sender = repositoryRuntime.nativeSender;
      assert.ok(sender);
      Object.assign(sender, {
        maintenanceIntervalMs: driver.maintenanceIntervalMs,
        durableBrokerReceipts: driver.durableBrokerReceipts,
        checkAdmissionReady: (signal) => driver.checkAdmissionReady(signal),
        open: (input, signal) => driver.open(input, signal),
        status: (sessionId, signal) => driver.status(sessionId, signal),
        close: (sessionId, signal) => driver.close(sessionId, signal),
      });
      return { repositoryRuntime, selection, tokenService: access.tokenService };
    },
  };
}

// Admission locks a Namespace, then its Agent. Every worker transaction that locks a claim's
// Agent must already hold the Namespace (#1742), or it deadlocks with a concurrent deploy,
// stop, delete or withdrawal. Records each Agent row lock taken first, with its stack.
function checkClaimLockOrder(worker, violations) {
  const transactWithQueue = worker.state.transactWithQueue.bind(worker.state);
  worker.state.transactWithQueue = (work, options) =>
    transactWithQueue((unit, queue) => work(trackLockOrder(unit, violations), queue), options);
}

// Test-only gate at run()'s single queue.claim() call. This pauses revision work
// claiming, not the process: independent OAuth maintenance remains live.
function gateRevisionClaims(worker, signal) {
  const claim = worker.queue.claim.bind(worker.queue);
  const stopLoop = worker.stopLoop.bind(worker);
  let request;
  worker.queue.claim = async (...args) => {
    const pending = request;
    if (pending) {
      // run() has awaited the preceding process and health; also drain any health
      // started by that claim's heartbeat before acknowledging the parked wrapper.
      await worker.pendingHealth;
      if (request === pending && !worker.stopping) {
        pending.parked = true;
        pending.ready.resolve();
        await pending.release.promise;
      }
    }
    // stopLoop marks stopping synchronously, before releasing a parked wrapper.
    if (worker.stopping) {
      return undefined;
    }
    return claim(...args);
  };
  worker.stopLoop = () => {
    const stopping = stopLoop();
    if (request) {
      request.ready.resolve(new Error("Worker stopped before revision claim pause"));
      request.release.resolve();
      request = undefined;
    }
    signal.removeEventListener("abort", abort);
    return stopping;
  };
  const abort = () => {
    // Ordinary fixture disposal still owns stop(), the selected owner and pool.
    void worker.stopLoop().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) {
    abort();
  }
  return {
    async pause() {
      assert.ok(!worker.stopping, "cannot pause a stopping Worker");
      request ??= {
        ready: Promise.withResolvers(),
        release: Promise.withResolvers(),
        parked: false,
      };
      const pending = request;
      // Bound arrival at the gate by the fixture's worker-stop limit; the owning
      // test signal bounds the parked lifetime. Failure drains rather than claims.
      const timer = setTimeout(abort, disposeLimitsMs["worker stop"]);
      try {
        const error = await pending.ready.promise;
        if (error) {
          throw error;
        }
        assert.ok(request === pending && pending.parked && !worker.stopping);
      } finally {
        clearTimeout(timer);
      }
    },
    resume() {
      assert.ok(request?.parked && !worker.stopping, "revision claim wrapper must be parked");
      const pending = request;
      request = undefined;
      pending.release.resolve();
    },
  };
}

function trackLockOrder(unit, violations) {
  const locked = new Set();
  const namespaces = {
    ...unit.namespaces,
    lockNamespace: async (namespaceId, ...rest) => {
      const namespace = await unit.namespaces.lockNamespace(namespaceId, ...rest);
      if (namespace !== undefined) {
        locked.add(namespaceId);
      }
      return namespace;
    },
  };
  const agents = {
    ...unit.agents,
    lockAgent: async (namespaceId, agentId, ...rest) => {
      const agent = await unit.agents.lockAgent(namespaceId, agentId, ...rest);
      // A lock that matched no row holds nothing.
      if (agent !== undefined && !locked.has(namespaceId)) {
        violations.push(
          new Error(`Agent ${agentId} locked before its Namespace ${namespaceId}`).stack,
        );
      }
      return agent;
    },
  };
  return Object.freeze({ ...unit, namespaces, agents });
}

// Node's test timeout does not cover after hooks, so a teardown step that never returned hung
// its file until the CI job timeout, naming nothing (finding 1209). Each step now has a limit.
// A step past it is left running and fails the hook naming the step, and the steps after it
// still run: the database drop (WITH (FORCE)) ends the sessions a stuck worker or pool still
// holds.
const disposeLimitsMs = {
  "worker stop": 30_000,
  "pool end": 15_000,
  // Waits for the CI state lock, which other files' test databases also take. The drop's lock
  // wait shares this limit; the drop itself has its own (scripts/ci/cleanup.mjs).
  "drop database": 120_000,
};

// A step left running can hold the process open (a socket, a child, a timer), so the file would
// sit idle after its last test until the runner's file timeout killed it (finding 1223). Once the
// file's teardown is done, a process that had abandoned a step exits after this grace, which
// leaves the test runner time to report. The timer is unref'd: a process with nothing left to
// wait for exits on its own first. The file must run under `node --test`, whose parent process
// counts the file's results (node:test sets a failing exit code only once the event loop drains).
const abandonedExitGraceMs = 2_000;
// Set by `createWorkerRevisionFixtures`; the fixture's own exit tests pass a shorter grace.
let exitGraceMs = abandonedExitGraceMs;
let abandonedSteps = 0;
let exitTimer;
let exitHookAdded = false;

function exitIfAbandoned() {
  if (abandonedSteps > 0) {
    // process.exit() keeps the exit code; the test runner reads results from its reports.
    exitTimer ??= setTimeout(() => process.exit(), exitGraceMs).unref();
  }
}

// `cleanup` runs as a root after hook, with the root test's context. A timer it armed itself cut
// off a root after hook registered after it (finding 1246), so it adds an after hook there:
// node:test runs a hook added while its after hooks run after the ones already registered, and
// that hook starts the grace if any step, in a test or a later hook, was abandoned. node:test
// skips the after hooks after a failing one, so a failed `cleanup`, or one called without a
// context, starts the grace at once. A later root after hook that fails skips that hook too
// (finding 1258), so a step abandoned before or after `cleanup` also arms a backstop: an exit
// 60 s later, unref'd too, well before the runner's file timeout. Normally the grace ends the
// file first.
const abandonedExitBackstopMs = 60_000;
// Set once `cleanup` has run: the tests are done, so a step abandoned from then on is teardown's.
let exitBackstopMs;
let exitBackstopTimer;

function exitAfterBackstop() {
  if (abandonedSteps > 0 && exitBackstopMs !== undefined) {
    exitBackstopTimer ??= setTimeout(() => process.exit(), exitBackstopMs).unref();
  }
}

function exitAfterRootHooks(context) {
  if (typeof context?.after !== "function") {
    exitIfAbandoned();
  } else if (!exitHookAdded) {
    exitHookAdded = true;
    context.after(exitIfAbandoned);
  }
}

export async function disposeStep(step, limitMs, work) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          abandonedSteps += 1;
          exitAfterBackstop();
          const error = new Error(
            `revision fixture teardown: ${step} did not finish within ${limitMs} ms`,
          );
          // In the file's output too, before the later steps run.
          console.error(error.message);
          reject(error);
        }, limitMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Importing this helper registers no tests or hooks.
// `exitGraceMs` and `exitBackstopMs` replace the abandoned-step grace and backstop for the
// fixture's own exit tests.
export function createWorkerRevisionFixtures(
  testFile,
  {
    exitGraceMs: graceMs = abandonedExitGraceMs,
    exitBackstopMs: backstopMs = abandonedExitBackstopMs,
  } = {},
) {
  exitGraceMs = graceMs;
  // The owning file registers this as a root after hook: `after(cleanup)`.
  function cleanup(context) {
    exitBackstopMs ??= backstopMs;
    exitAfterBackstop();
    exitAfterRootHooks(context);
  }

  async function prepareDatabase(context, limitsMs = {}) {
    const limits = { ...disposeLimitsMs, ...limitsMs };
    assert.ok(
      process.env.OPENCLAW_ENTERPRISE_CI_STATE,
      "Worker tests require an owned PostgreSQL fixture; see docs/testing/postgresql.md.",
    );
    // Each test owns a database (Work claims span one), a copy of the migrated database prepared
    // for this file (OCC_TEST_DATABASE_URL), its template. Nothing in a revision file connects to
    // that database: PostgreSQL refuses to copy a database that has sessions, and a write to it
    // would reach every later copy. Whoever prepared it drops it after the file. A copy holds the
    // CI state lock briefly, but a file's first test still waits for that lock while the runner
    // prepares the files that start with it. Those are copies of one migrated lane template
    // since finding 2178; a migration per file there made a 4 s first test take 10-26 s on CI.
    // Before that, each file also migrated a template of its own (findings 1209, 1270).
    assert.ok(
      process.env.OCC_TEST_DATABASE_URL,
      "Worker tests copy the database prepared for their file; see docs/testing/postgresql.md.",
    );
    const prepared = await prepareFile({
      lane: "postgres-application",
      file: fileURLToPath(testFile),
      statePath: process.env.OPENCLAW_ENTERPRISE_CI_STATE,
      template: process.env.OCC_TEST_DATABASE_URL,
    });
    const pools = new Set();
    const workers = new Set();
    let disposal;
    function dispose() {
      return (disposal ??= (async () => {
        const failures = [];
        const run = async (step, work) => {
          try {
            await disposeStep(step, limits[step], work);
          } catch (error) {
            failures.push(error);
          }
        };
        // Work claims span the entire database. Join every worker owned by this
        // fixture before dropping it; never rewrite another worker's live claim.
        for (const worker of workers) {
          await run("worker stop", () => worker.stop());
        }
        for (const pool of pools) {
          // pg-pool's end() resolves once its idle clients are removed, before their sessions
          // close. The drop below can end a session still closing; the server's 57P01 then
          // reaches the pool's idle listener, which re-emits it on the pool, and with no
          // listener that throws in this test's teardown (finding 2379). The pool is done.
          pool.on("error", () => {});
          // A pool already ending was ended by its worker's stop or by the test.
          if (!pool.ending) {
            await run("pool end", () => pool.end());
          }
        }
        await run("drop database", () =>
          prepared.cleanup({ lockTimeoutMs: limits["drop database"] }),
        );
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length > 1) {
          throw new AggregateError(
            failures,
            `revision fixture teardown failed: ${failures.map(({ message }) => message).join("; ")}`,
          );
        }
      })());
    }
    context.after(dispose);
    return { url: prepared.env.OCC_TEST_DATABASE_URL, pools, workers, dispose };
  }

  async function setup(
    context,
    {
      database,
      leaseDurationMs = 30_000,
      maxAttempts = 5,
      onHealthy,
      onProgress,
      metrics,
      repoDriver = /** @type {ReturnType<typeof import("./postgres-worker-revision-support.mjs").repositoryBoundary>["driver"] | undefined} */ (
        undefined
      ),
      repositoryAdmission,
      driverSelections = {},
      backends = /** @type {import("../../packages/contracts/src/index.ts").BackendDefinition[]} */ ([]),
      secretAuthMethod = "api_key",
      // Shorter teardown step limits, for a test of the teardown itself.
      disposeLimitsMs: limitsMs,
    } = {},
  ) {
    const [
      { Pool },
      { createControllerWorker },
      { createDevelopmentComputeDriver },
      { DEVELOPMENT_HARNESS_DESCRIPTOR, PRODUCTION_HARNESS_DESCRIPTOR },
      { PostgresPlatformState },
      { PostgresWorkQueue },
    ] = await Promise.all([
      import("pg"),
      import("../../apps/controller/src/worker.ts"),
      import("./development.mjs"),
      import("../../apps/controller/src/composition/production-harness.ts"),
      import("../../packages/occ/src/state/postgres-state.ts"),
      import("../../packages/occ/src/state/postgres-work-queue.ts"),
    ]);
    database ??= await prepareDatabase(context, limitsMs);
    function createPool(max) {
      const pool = new Pool({ connectionString: database.url, max });
      database.pools.add(pool);
      return pool;
    }
    const observerPool = createPool(8);
    const createWorkerPool = () => createPool(1);
    let workerPool = createWorkerPool();
    const state = new PostgresPlatformState(observerPool);
    repoDriver?.bindReceiptState?.(state);
    const installation = await ensureInstallation(state, "revision-worker");
    const actor = authorizedPrincipal(await state.loadNativeIAMState(), [
      ["deploy", "agent"],
      ["delete", "agent"],
      ["delete", "secret"],
    ]);
    assert.ok(
      actor,
      "persisted IAM must contain a Principal authorized for Agent lifecycle and Secret cleanup",
    );

    const namespace = {
      id: `ns_${randomUUID()}`,
      name: `revision-worker-${randomUUID()}`,
      status: "ready",
      createdAt: new Date().toISOString(),
    };
    let worker;
    let revisionClaims;
    const lockOrderViolations = [];
    // A throwing after hook skips every later one, which can leave a worker running and the
    // file hanging. A hook added while after hooks run goes last, so check from there.
    context.after(() =>
      context.after(() =>
        assert.deepEqual(
          lockOrderViolations,
          [],
          "the worker locked an Agent before its Namespace",
        ),
      ),
    );
    await state.transact((unit) => unit.namespaces.createNamespace(namespace));
    const compute = {
      ...createDevelopmentComputeDriver(),
      ...(repoDriver === undefined
        ? {}
        : {
            validateRepositoryCredentials(harness, sandboxDriverId) {
              assert.equal(harness.mode, "embedded");
              assert.equal(sandboxDriverId, undefined);
            },
          }),
    };
    const secretDriver = createBackendWorkerDrivers(compute, []).secretDriver;
    const repository =
      repoDriver && (await repositoryWorkerFixture(context, repoDriver, namespace.id));
    if (repository) {
      backends = [
        ...backends.filter((backend) => backend.id !== repository.backend.id),
        repository.backend,
      ];
    }
    const controller = createBackendController(
      { installation, state },
      {
        backends,
        repositoryAdmission: repositoryAdmission ?? repository?.admission,
        driverConfigurations: installationDriverConfigurations({ drivers: driverSelections }),
      },
    );
    controller.registerDriver(secretDriver);
    controller.selectDriver("secret", secretDriver.id);
    const secretRoleId = `role-${randomUUID()}`;
    await observerPool.query(
      `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        secretRoleId,
        namespace.id,
        `Harness Secrets ${randomUUID()}`,
        JSON.stringify([{ action: "operate", resourceKind: "secret" }]),
      ],
    );

    async function agent(
      label,
      {
        executionMode = "embedded",
        serviceAccountId,
        backendId = null,
        grantHarnessSecret = true,
        auth = "secret",
        nonModelSources = 0,
        modelConfig = {},
      } = {},
    ) {
      const id = `agt_${randomUUID()}`;
      // Tool sources are ready gateway-held tokens in the same Namespace as the Agent.
      const credentialSources = [];
      for (let index = 0; index < nonModelSources; index += 1) {
        const source = {
          id: `cs_${randomUUID()}`,
          namespaceId: namespace.id,
          name: `${label}-tool-${index}-${randomUUID()}`,
          type: "bearer-token",
          config: { host: `api-${index}.example.com`, env_var: `TOOL_TOKEN_${index}` },
          secrets: {},
          ownerCapability: "credential_gateway",
          driverId: CREDENTIAL_GATEWAY_FIXTURE_ID,
          state: "registering",
          createdAt: new Date().toISOString(),
        };
        await state.transact(async (unit) => {
          await unit.credentialSources.createCredentialSource(source);
          await unit.credentialSources.markCredentialSourceReady(namespace.id, source.id);
        });
        credentialSources.push({ sourceId: source.id });
      }
      const configurationId = `cfg_${randomUUID()}`;
      let harnessAuth;
      if (auth === "runtime") {
        harnessAuth = { method: "runtime" };
      } else if (auth === "credential_source") {
        // A gateway-held model key, as registration leaves it once the gateway confirms its copy.
        const source = {
          id: `cs_${randomUUID()}`,
          namespaceId: namespace.id,
          name: `${label}-${randomUUID()}`,
          type: "openai",
          config: modelConfig,
          secrets: {},
          ownerCapability: "credential_gateway",
          driverId: CREDENTIAL_GATEWAY_FIXTURE_ID,
          state: "registering",
          createdAt: new Date().toISOString(),
        };
        await state.transact(async (unit) => {
          await unit.credentialSources.createCredentialSource(source);
          await unit.credentialSources.markCredentialSourceReady(namespace.id, source.id);
        });
        harnessAuth = { method: "credential_source", sourceId: source.id };
      } else if (serviceAccountId === undefined) {
        const identity = {
          id: `sec_${randomUUID()}`,
          namespaceId: namespace.id,
          name: `key-${randomUUID()}`,
        };
        const backendRef = await secretDriver.create(identity, "worker-fixture-key");
        await state.transact((unit) =>
          unit.secrets.createSecret({
            ...identity,
            driverId: secretDriver.id,
            backendRef,
            createdAt: new Date().toISOString(),
          }),
        );
        harnessAuth = {
          method: secretAuthMethod,
          source: { kind: "secret", namespaceId: namespace.id, id: identity.id },
        };
      } else {
        harnessAuth = {
          method: "codex_pat",
          source: { kind: "service_account", namespaceId: namespace.id, id: serviceAccountId },
        };
      }
      // The list holds every bound source: the Harness source first, then the others.
      const listedSources = [
        ...(harnessAuth.method === "credential_source" ? [{ sourceId: harnessAuth.sourceId }] : []),
        ...credentialSources,
      ];
      const owner = await state.transact(async (unit) => {
        await unit.configurations.createConfiguration({
          id: configurationId,
          namespaceId: namespace.id,
          kind: "agent",
          generation: 1,
          createdAt: new Date().toISOString(),
        });
        return unit.agents.createAgent({
          id,
          namespaceId: namespace.id,
          name: `${label}-${randomUUID()}`,
          configurationId,
          backendId,
          harnessAuth,
          ...(listedSources.length === 0 ? {} : { credentialSources: listedSources }),
          executionMode,
          servicePrincipalId: `service-agent-${id}`,
          createdAt: new Date().toISOString(),
        });
      });
      const operatedSources = listedSources.map(({ sourceId }) => sourceId);
      if (operatedSources.length > 0) {
        // Deployment requires the Agent, like the deploying actor, to operate its source.
        const sourceRoleId = `role-${randomUUID()}`;
        await observerPool.query(
          `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [
            sourceRoleId,
            namespace.id,
            `Credential sources ${randomUUID()}`,
            JSON.stringify([{ action: "operate", resourceKind: "credential_source" }]),
          ],
        );
        for (const sourceId of operatedSources) {
          await observerPool.query(
            `INSERT INTO occ.iam_access_bindings
            (id, namespace_id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id)
           VALUES ($1, $2, $3, NULL, $4, 'credential_source', $5)`,
            [
              `binding-${randomUUID()}`,
              namespace.id,
              owner.servicePrincipalId,
              sourceRoleId,
              sourceId,
            ],
          );
        }
      }
      if (
        (harnessAuth.method === "api_key" || harnessAuth.method === "codex_pat") &&
        harnessAuth.source.kind === "secret" &&
        grantHarnessSecret
      ) {
        await observerPool.query(
          `INSERT INTO occ.iam_access_bindings
            (id, namespace_id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id)
           VALUES ($1, $2, $3, NULL, $4, 'secret', $5)`,
          [
            `binding-${randomUUID()}`,
            namespace.id,
            owner.servicePrincipalId,
            secretRoleId,
            harnessAuth.source.id,
          ],
        );
      }
      return owner;
    }

    async function revision(
      owner,
      number,
      {
        harness,
        sandboxDriverId,
        protectedRepositoryDriver,
        repositoryCredentials,
        actorId = actor.id,
        plugins,
        workAge,
        // How far the controller clock that stamps the admission runs ahead of PostgreSQL's
        // (negative: behind). The store restamps admission on its own clock (finding 1195).
        controllerSkewMs = 0,
        compute: admittedCompute = { id: compute.id, implementation: compute.implementation },
      } = {},
    ) {
      let harnessAuth;
      if (owner.harnessAuth.method === "runtime") {
        harnessAuth = owner.harnessAuth;
      } else if (owner.harnessAuth.method === "credential_source") {
        const source = await state.read((view) =>
          view.credentialSources.findCredentialSource(namespace.id, owner.harnessAuth.sourceId),
        );
        harnessAuth = {
          method: "credential_source",
          sourceId: source.id,
          credentialGatewayId: source.driverId,
          sourceType: source.type,
          loginMode: "api_key",
        };
      } else if (
        owner.harnessAuth.method === "codex_pat" &&
        owner.harnessAuth.source.kind === "service_account"
      ) {
        const account = await state.read((view) =>
          view.serviceAccounts.findServiceAccount(namespace.id, owner.harnessAuth.source.id),
        );
        const backendBinding = await state.read((view) =>
          view.serviceAccounts.findServiceAccountBackendBinding(namespace.id, account.id),
        );
        harnessAuth = { ...owner.harnessAuth, credential: account.credential, backendBinding };
      } else {
        harnessAuth = { ...owner.harnessAuth, secretDriverId: secretDriver.id };
      }
      const credentialSources = [];
      for (const { sourceId } of owner.credentialSources ?? []) {
        const source = await state.read((view) =>
          view.credentialSources.findCredentialSource(namespace.id, sourceId),
        );
        credentialSources.push({
          sourceId,
          credentialGatewayId: source.driverId,
          sourceType: source.type,
        });
      }
      const approvedHarness =
        harness ??
        (owner.executionMode === "dedicated"
          ? { ...PRODUCTION_HARNESS_DESCRIPTOR, mode: "dedicated" }
          : { ...DEVELOPMENT_HARNESS_DESCRIPTOR, mode: "embedded" });
      const candidate = {
        id: `rev_${randomUUID()}`,
        namespaceId: namespace.id,
        agentId: owner.id,
        revision: number,
        gatewayManagedMode: owner.gatewayManagedMode,
        backendId: owner.backendId,
        configuration: { revision: String(number) },
        configurationId: owner.configurationId,
        configurationKind: "agent",
        configurationGeneration: 1,
        executionAdmission: { version: 2, mode: "unprotected" },
        harness: { ...approvedHarness, overrides: {}, configuration: {} },
        compute: { ...admittedCompute },
        ...(sandboxDriverId === undefined ? {} : { sandboxDriverId }),
        ...(plugins === undefined ? {} : { plugins }),
        harnessAuth,
        ...(credentialSources.length === 0 ? {} : { credentialSources }),
        servicePrincipalId: owner.servicePrincipalId,
        ...(repositoryCredentials === undefined ? {} : { repositoryCredentials }),
        createdAt: new Date(Date.now() + controllerSkewMs).toISOString(),
      };
      if (protectedRepositoryDriver) {
        const sandbox = protectedRepositoryDriver.require("sandbox");
        await state.transact(async (unit) => {
          const [auth] = await controller.admitHarnessAuth(unit, actorId, owner);
          assert.deepEqual(auth, harnessAuth);
          const sources = await controller.admitCredentialSources(
            unit,
            actorId,
            owner,
            sandbox,
            undefined,
            candidate.harness,
            compute,
          );
          assert.deepEqual(sources, credentialSources);
          const configuration = { agents: { defaults: { model: "codex/fixture-model" } } };
          const plan = (chosen) =>
            controller.admitProxyPlan(
              unit,
              owner,
              candidate.id,
              configuration,
              sandbox.id,
              repositoryCredentials,
              chosen,
              candidate.harness.configuration,
            );
          await assert.rejects(
            plan({ ...auth, sourceId: "unselected" }),
            /created or adopted under the Proxy/,
          );
          const egressPlan = await plan(auth);
          assert.deepEqual(egressPlan.harnessCredentialSource, auth);
          assert.deepEqual(
            egressPlan.routes,
            [],
            "no model route or credential was granted to Git",
          );
          Object.assign(candidate, {
            configuration,
            egressPlan,
            executionAdmission: {
              version:
                egressPlan.repositoryGitAuthorization === "request-hook-observed"
                  ? 6
                  : egressPlan.repositoryGitAuthorization === "online-request"
                    ? 5
                    : 4,
              mode: "protected",
            },
            sandboxDriverId: sandbox.id,
          });
        });
      }
      const idempotencyKey = `agent_revision:${candidate.id}:reconcile`;
      let admitted;
      await state.transactWithQueue(async (unit, queue) => {
        // Match production Namespace→Agent admission order so queue foreign keys
        // cannot deadlock with a worker holding the Namespace while locking the Agent.
        await unit.namespaces.lockNamespace(namespace.id);
        await unit.agents.lockAgent(namespace.id, owner.id);
        candidate.harness.configuration =
          compute.resolveHarnessConfiguration?.(
            candidate.harness,
            harnessAuth,
            candidate.configuration,
          ) ?? {};
        const admission = compute.admitRevision?.(freezeAgentRevision(candidate));
        if (admission !== undefined) {
          candidate.compute = { ...candidate.compute, admission };
        }
        admitted = await unit.revisions.createRevision(candidate);
        await unit.agents.transitionAgentDesiredRuntimeState(
          namespace.id,
          owner.id,
          ["stopped", "running"],
          "running",
        );
        if (workAge === undefined) {
          await queue.enqueue({
            idempotencyKey,
            namespaceId: namespace.id,
            agentId: owner.id,
            revisionId: candidate.id,
            actorId,
            availableAt: new Date(0),
          });
        }
      });
      if (workAge !== undefined) {
        // Work admitted `workAge` (a PostgreSQL interval) ago by the database clock, which
        // the worker judges work age by. The application role cannot rewrite created_at.
        await observerPool.query(
          `INSERT INTO occ.controller_work (
             idempotency_key, namespace_id, agent_id, revision_id, actor_id,
             state, available_at, attempt_count, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, 'queued', to_timestamp(0), 0,
             clock_timestamp() - $6::interval, clock_timestamp()
           )`,
          [idempotencyKey, namespace.id, owner.id, candidate.id, actorId, workAge],
        );
      }
      return { ...candidate, createdAt: admitted.createdAt, idempotencyKey };
    }

    async function work(candidate, expected, timeoutMs) {
      return waitFor(
        `revision ${candidate.id} to become ${expected}`,
        async () => {
          const rows = await observerPool.query(
            "SELECT state, claim_token, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
            [candidate.idempotencyKey],
          );
          return rows.rows[0]?.state === expected ? rows.rows[0] : undefined;
        },
        timeoutMs,
      );
    }

    async function requestStop(owner) {
      await controller.stopAgent(actor.id, namespace.id, owner.id);
      const work = await observerPool.query(
        `SELECT idempotency_key FROM occ.controller_work
         WHERE namespace_id = $1 AND agent_id = $2 AND agent_target = 'stopped'
         ORDER BY created_at DESC LIMIT 1`,
        [namespace.id, owner.id],
      );
      assert.equal(work.rowCount, 1, "OCC.stopAgent must durably enqueue its authorized stop");
      return { id: owner.id, idempotencyKey: work.rows[0].idempotency_key };
    }

    async function requestDeletion(owner) {
      const idempotencyKey = `agent:${owner.id}:reconcile:deleted`;
      await controller.deleteAgent(actor.id, namespace.id, owner.id);
      return { id: owner.id, idempotencyKey };
    }

    async function start(
      computeDriver,
      {
        emit = /** @type {NonNullable<Parameters<typeof createControllerWorker>[0]["emit"]>} */ (
          () => {}
        ),
        convergenceTimeoutMs,
        providers,
        pool = workerPool,
        transformDrivers = (drivers) => drivers,
        repositoryGitMaterial,
        pauseableRevisionClaims = false,
      } = {},
    ) {
      const configuredDrivers = createBackendWorkerDrivers(computeDriver, providers ?? []);
      const native = repository && (await repository.worker(computeDriver));
      const drivers = transformDrivers({
        ...configuredDrivers,
        installation: {
          ...configuredDrivers.installation,
          backend: [
            ...(configuredDrivers.installation.backend ?? []),
            ...backends.filter((backend) => backend.type === "github"),
          ],
          drivers: { ...configuredDrivers.installation.drivers, ...driverSelections },
          ...(native && { repository: native.selection }),
        },
        secretDriver,
        ...(native && {
          repositoryRuntime: native.repositoryRuntime,
          tokenService: native.tokenService,
        }),
      });
      worker = createControllerWorker({
        metrics,
        pool,
        pollIntervalMs: 15,
        leaseDurationMs,
        maxAttempts,
        onHealthy,
        onProgress,
        ...(drivers === undefined ? { computeDriver } : { drivers }),
        ...(convergenceTimeoutMs === undefined ? {} : { convergenceTimeoutMs }),
        ...(repositoryGitMaterial === undefined ? {} : { repositoryGitMaterial }),
        emit,
      });
      database.workers.add(worker);
      checkClaimLockOrder(worker, lockOrderViolations);
      revisionClaims = pauseableRevisionClaims
        ? gateRevisionClaims(worker, context.signal)
        : undefined;
      return worker.start();
    }

    async function stop() {
      if (worker !== undefined) {
        await worker.stop();
        worker = undefined;
        revisionClaims = undefined;
        workerPool = createWorkerPool();
      }
    }

    async function pauseRevisionClaims() {
      assert.ok(revisionClaims, "Worker must opt into revision claim pausing");
      await revisionClaims.pause();
    }

    function resumeRevisionClaims() {
      assert.ok(revisionClaims, "Worker must opt into revision claim pausing");
      revisionClaims.resume();
    }

    async function stopLoopRetainingOwner() {
      assert.ok(worker);
      await worker.stopLoop();
      // Keep this Worker in database.workers: ordinary disposal closes its owner
      // and pool after both old and replacement listeners have been exercised.
      worker = undefined;
      revisionClaims = undefined;
      workerPool = createWorkerPool();
    }

    async function admitInitialRevision(
      label,
      { agent: agentOptions, revision: revisionOptions } = {},
    ) {
      const owner = await agent(label, agentOptions);
      const candidate = await revision(owner, 1, revisionOptions);
      return { owner, candidate };
    }

    function currentAgent(owner) {
      return state.read((view) => view.agents.findAgent(namespace.id, owner.id));
    }

    function activePointer(owner) {
      return observerPool.query(
        "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
        [namespace.id, owner.id],
      );
    }

    function deploymentStatus(owner, candidate) {
      return controller.getDeploymentStatus(actor.id, namespace.id, owner.id, candidate.id);
    }

    function workResult(candidate) {
      return observerPool.query(
        "SELECT reason_code, result_data FROM occ.controller_work WHERE idempotency_key = $1",
        [candidate.idempotencyKey],
      );
    }

    function expireClaim(candidate, claimToken) {
      return observerPool.query(
        `UPDATE occ.controller_work
         SET lease_expires_at = clock_timestamp() - interval '1 second'
         WHERE idempotency_key = $1 AND claim_token = $2::uuid`,
        [candidate.idempotencyKey, claimToken],
      );
    }

    // Provisions actorId with the fixture actor's direct bindings. withoutActions binds each
    // scope to a copy of its role minus those actions instead, so the identity is provisioned
    // and keeps its other grants but lacks exactly those permissions. An action is dropped for
    // every resource kind (["delete"] also drops delete secret). The copied roles keep the
    // source role's scope, usually Installation-wide, so Namespace teardown never removes them;
    // like the copied identity they live until the per-file database is dropped.
    /**
     * @param {string} actorId
     * @param {{ withoutActions?: string[] }} [options]
     */
    async function copyActorGrants(actorId, { withoutActions = [] } = {}) {
      await observerPool.query(
        `INSERT INTO occ.iam_identities (id, kind, issuer, subject)
         SELECT $1, kind, issuer, $1 FROM occ.iam_identities WHERE id = $2`,
        [actorId, actor.id],
      );
      if (withoutActions.length === 0) {
        await observerPool.query(
          `INSERT INTO occ.iam_access_bindings
             (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id)
           SELECT 'binding-' || gen_random_uuid(), namespace_id, $1, role_id,
                  resource_kind, resource_id
           FROM occ.iam_access_bindings WHERE identity_subject_id = $2`,
          [actorId, actor.id],
        );
        return;
      }
      const { rows: bindings } = await observerPool.query(
        `SELECT b.namespace_id, b.resource_kind, b.resource_id,
                r.namespace_id AS role_namespace_id, r.permissions
         FROM occ.iam_access_bindings AS b JOIN occ.iam_roles AS r ON r.id = b.role_id
         WHERE b.identity_subject_id = $1`,
        [actor.id],
      );
      assert.ok(bindings.length > 0, "the fixture actor must hold direct bindings to copy");
      for (const binding of bindings) {
        const permissions = binding.permissions.filter(
          (permission) => !withoutActions.includes(permission.action),
        );
        if (permissions.length === 0) {
          continue;
        }
        const roleId = `role-${randomUUID()}`;
        await observerPool.query(
          `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
           VALUES ($1, $2, NULL, $3::jsonb)`,
          [roleId, binding.role_namespace_id, JSON.stringify(permissions)],
        );
        await observerPool.query(
          `INSERT INTO occ.iam_access_bindings
             (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            `binding-${randomUUID()}`,
            binding.namespace_id,
            actorId,
            roleId,
            binding.resource_kind,
            binding.resource_id,
          ],
        );
      }
    }

    // Advance only this revision's queued observation, preserving its claim and actor.
    function advanceMaintenance(candidate) {
      return observerPool.query(
        `UPDATE occ.controller_work SET available_at = clock_timestamp()
         WHERE revision_id = $1 AND state = 'queued' AND idempotency_key LIKE $2
         RETURNING idempotency_key, actor_id, attempt_count`,
        [candidate.id, `agent_revision:${candidate.id}:maintenance:%`],
      );
    }

    return {
      expireClaim,
      copyActorGrants,
      admitInitialRevision,
      advanceMaintenance,
      currentAgent,
      activePointer,
      deploymentStatus,
      workResult,
      database,
      installation,
      controller,
      actor,
      namespace,
      observerPool,
      state,
      compute,
      secretDriver,
      repositoryAdmission: repository?.admission,
      productionHarness: PRODUCTION_HARNESS_DESCRIPTOR,
      PostgresWorkQueue,
      agent,
      revision,
      requestDeletion,
      requestStop,
      work,
      start,
      stop,
      pauseRevisionClaims,
      resumeRevisionClaims,
      stopLoopRetainingOwner,
      createWorkerPool,
      workerPool,
    };
  }

  function revisionTest(name, run, options = {}) {
    test(name, { ...requiresPostgres, ...options }, async (context) => {
      const fixture = await setup(context);
      await run(fixture, context);
    });
  }

  return { setup, cleanup, revisionTest };
}
