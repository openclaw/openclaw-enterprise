import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Pool } from "pg";
import type { App, Request, Session } from "./postgres-production-sharing-cases.ts";
import type { InstallationRuntimeDrivers } from "../../apps/controller/src/composition/installation-config.ts";
import type { ProductionStartupPhase } from "../../apps/controller/src/composition/production.ts";
import {
  runSharingCases,
  recordId,
  record,
  records,
  text,
  json,
  parsePrivateJson,
  row,
} from "./postgres-production-sharing-cases.ts";
import { dirname, join } from "node:path";
import test from "node:test";
import { createServer } from "node:net";
import { startApi } from "../../apps/controller/src/api-startup.mjs";
import { listen } from "../helpers/listen.ts";
import { setEnvironment } from "../helpers/environment.ts";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { FilesystemConfigurationDriver } from "../../apps/controller/src/drivers/configuration/filesystem/index.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { setTimeout as delay } from "node:timers/promises";
import { composePostgresDevelopment, composeProduction } from "../helpers/password-hasher.mjs";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { createOccLogger } from "../../apps/controller/src/logging.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { createReadyComputeDriver } from "../helpers/development.mjs";
import {
  createConsoleFixtureTransport,
  fetchLoopback,
} from "../helpers/console-fixture-transport.ts";
import {
  authenticatedHeaders,
  signInWithEmailPassword as signInThroughTransport,
} from "../helpers/auth-session.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { jsonLineDestination } from "../helpers/json-lines.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { createDeviceCredentialDrivers } from "../helpers/device-credential-gateway.mjs";
import { normalizePresetTemplate } from "../../packages/contracts/src/index.ts";
import {
  BOOTSTRAP_DEFAULT_NAMESPACE_NAME,
  PostgresPlatformState,
  InstalledDriver,
  OpenClawController,
} from "../../packages/occ/src/index.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { readPrivateBootstrapOutput } from "../helpers/bootstrap-output.ts";
import { waitUntil } from "../helpers/wait-for.mjs";
import { createDriver as createProtectedFixture } from "../fixtures/driver-packages/protected-execution-driver/index.ts";

const databaseUrl = process.env.OCC_PRODUCTION_WIREUP_DATABASE_URL;
const repository = fileURLToPath(new URL("../../", import.meta.url));
const run = promisify(execFile);
const adminEmail = "admin@example.test";
const authSecret = "production-wireup-auth-secret-at-least-32-bytes";
const authBaseURL = "https://console.oce.localhost";
const nativeAdmin = { enabled: false, domain: "agents.oce.localhost" };

async function signInWithEmailPassword({
  origin: transportOrigin,
  ...options
}: {
  origin: string;
  email: string;
  password: string;
  path?: string;
}): Promise<Session> {
  const transport = createConsoleFixtureTransport(authBaseURL, transportOrigin);
  const session = await signInThroughTransport({
    ...options,
    origin: authBaseURL,
    rememberMe: undefined,
    fetch: async (input, init) => {
      const response = await transport.fetchThroughLoopback(new Request(input, init));
      // A broken sign-in response could echo the submitted password. Report only its status.
      if (!response.ok) {
        throw new Error(`Better Auth email/password sign-in failed with HTTP ${response.status}`);
      }
      return response;
    },
  });
  const setCookie: unknown = session.setCookie;
  assert.ok(
    Array.isArray(setCookie) && setCookie.every((value: unknown) => typeof value === "string"),
  );
  return { ...session, setCookie };
}

async function defaultNamespaceRows(pool: Pool) {
  return (
    await pool.query<Record<string, unknown>>(
      `SELECT namespace.id, namespace.name, namespace.status, work.idempotency_key
       FROM occ.namespaces AS namespace
       JOIN occ.controller_work AS work ON work.namespace_id = namespace.id
       WHERE namespace.name = $1`,
      [BOOTSTRAP_DEFAULT_NAMESPACE_NAME],
    )
  ).rows;
}

function createPassiveComputeDriver() {
  return createReadyComputeDriver("compute-production-wireup", {
    implementation: "production-wireup-memory-compute",
    async preflight() {
      return {
        warnings: [
          {
            code: "KUBERNETES_VERSION_BELOW_MINIMUM",
            message: "Kubernetes 1.34.12 is below the supported minimum 1.35.0.",
          },
        ],
      };
    },
  });
}

function memoryLog() {
  const lines: unknown[] = [];
  return {
    lines,
    logger: createOccLogger({
      component: "occ-api-production-wireup",
      destination: jsonLineDestination(lines),
    }),
  };
}

async function runSuccessfulBootstrap(
  environment: NodeJS.ProcessEnv,
  event: "installation.bootstrapped" | "installation.already-bootstrapped",
) {
  const result = await run(process.execPath, ["scripts/bootstrap-installation.mjs"], {
    cwd: repository,
    env: environment,
  }).catch(() => {
    throw new Error(`bootstrap command failed while expecting ${event}`);
  });
  assert.ok(result.stdout.includes(event), `bootstrap output must contain ${event}`);
  return result;
}

function parseLogEvents(stderr: string) {
  return stderr
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => record(parsePrivateJson(line, "bootstrap error log")));
}

type DriverOptions = { includeDefaults?: boolean; files?: string[]; configurationRoot?: string };

async function productionDrivers({
  includeDefaults = false,
  files,
  configurationRoot,
}: DriverOptions = {}): Promise<InstallationRuntimeDrivers> {
  const configuration = {
    ...createInstallationDriverConfiguration(),
    presets: { includeDefaults, ...(files === undefined ? {} : { files }) },
  };
  configuration.drivers.compute.id = "compute-production-wireup";
  configuration.drivers.iam.id = "native-iam";
  const runtime = await loadInstallationConfiguration({
    mode: "production",
    environment: {},
    startupConfiguration: {
      configuration,
      logging: { level: "info" },
    },
  });
  assert.ok(runtime);
  const { installation } = runtime;
  return {
    installation,
    ...(runtime.defaultPresets === undefined ? {} : { defaultPresets: runtime.defaultPresets }),
    ...(runtime.shadowedDefaultPresets === undefined
      ? {}
      : { shadowedDefaultPresets: runtime.shadowedDefaultPresets }),
    ...(runtime.bundledPresetVersions === undefined
      ? {}
      : { bundledPresetVersions: runtime.bundledPresetVersions }),
    computeDriver: createPassiveComputeDriver(),
    configurationDriver: configurationRoot
      ? new FilesystemConfigurationDriver(configurationRoot)
      : createTestConfigurationDriver({ id: installation.drivers.configuration.id }),
    secretDriver: createTestSecretDriver({
      id: installation.drivers.secret.id,
    }),
    createIAMDriver(state) {
      return new NativeIAMDriver(state, {
        id: installation.drivers.iam.id,
        implementation: installation.drivers.iam.implementation,
      });
    },
  };
}

test(
  "production bootstrap creates a generated-password administrator that can authenticate",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_PRODUCTION_WIREUP_DATABASE_URL for real PostgreSQL production bootstrap proof.",
  },
  async (t) => {
    assert.ok(databaseUrl);
    const environment = {
      ...process.env,
      NODE_ENV: "production",
      OCC_DATABASE_URL: databaseUrl,
      OCC_AUTH_SECRET: authSecret,
      OCC_AUTH_BASE_URL: authBaseURL,
      OCC_AGENT_NATIVE_ADMIN_DOMAIN: nativeAdmin.domain,
      OCC_BOOTSTRAP_ADMIN_EMAIL: adminEmail,
      OCC_BOOTSTRAP_PASSWORD_FILE: join(
        await temporaryDirectory(t, "openclaw-enterprise-bootstrap-password-"),
        "admin-password",
      ),
      OCC_BOOTSTRAP_SERVICE_KEY_FILE: "",
      OCC_BOOTSTRAP_INSTALLATION_NAME: "openclaw-enterprise",
    };
    const passwordDirectory = dirname(environment.OCC_BOOTSTRAP_PASSWORD_FILE);
    environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE = join(
      passwordDirectory,
      "initial-admin-service-key.json",
    );
    let app: App | undefined;
    let endpoint = "";
    let pool: Pool | undefined;
    try {
      // Run the actual production Job; the generated credential is handed off only via the
      // protected operator-selected file.
      const bootstrapped = await runSuccessfulBootstrap(environment, "installation.bootstrapped");

      pool = new Pool({ connectionString: databaseUrl });
      // Creating an administrator is not signing in: no usable session may exist yet.
      const bootstrapSessions = await pool.query<Record<string, unknown>>(
        "SELECT count(*)::integer AS count FROM occ.session",
      );
      assert.equal(row(bootstrapSessions).count, 0);
      const defaultNamespace = await defaultNamespaceRows(pool);
      assert.equal(defaultNamespace.length, 1);
      const defaultNamespaceRow = record(defaultNamespace[0]);
      const defaultNamespaceId = text(defaultNamespaceRow.id);
      assert.match(defaultNamespaceId, /^ns_/);
      assert.equal(defaultNamespaceRow.name, BOOTSTRAP_DEFAULT_NAMESPACE_NAME);
      assert.equal(defaultNamespaceRow.status, "provisioning");
      assert.equal(
        defaultNamespaceRow.idempotency_key,
        `namespace:${defaultNamespaceId}:reconcile:ready`,
      );

      const passwordFile = environment.OCC_BOOTSTRAP_PASSWORD_FILE;
      const serviceKeyFile = environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE;
      const password = (await readPrivateBootstrapOutput(passwordFile)).trim();
      assert.ok(/^[A-Za-z0-9_-]{43}$/.test(password), "invalid bootstrap password format");
      assert.ok(
        password !== adminEmail,
        "bootstrap password must differ from the administrator email",
      );
      assert.ok(
        password !== authSecret,
        "bootstrap password must differ from the authentication secret",
      );
      const serviceKeyBytes = await readPrivateBootstrapOutput(serviceKeyFile);
      const serviceKeyOutput = record(
        parsePrivateJson(serviceKeyBytes, "bootstrap service-key output"),
      );
      const serviceKeyData = record(serviceKeyOutput.data);
      const serviceKeyMeta = record(serviceKeyOutput.meta);
      const serviceKey = text(serviceKeyData.key);
      assert.ok(serviceKeyData.name === "bootstrap-admin", "incorrect bootstrap service-key name");
      assert.ok(
        text(serviceKeyData.servicePrincipalId).startsWith("spn_"),
        "invalid bootstrap principal ID",
      );
      assert.ok(
        serviceKey.startsWith("occ_") &&
          serviceKey.length > "occ_".length &&
          !/[^!-~]/.test(serviceKey),
        "invalid bootstrap service-key format",
      );
      assert.equal(text(serviceKeyMeta.installationId).startsWith("ins_"), true);
      assert.equal(
        bootstrapped.stdout.includes(password),
        false,
        "stdout must not contain password",
      );
      assert.equal(
        bootstrapped.stdout.includes(serviceKey),
        false,
        "stdout must not contain service key",
      );
      assert.equal(
        bootstrapped.stderr.includes(password),
        false,
        "stderr must not contain password",
      );
      assert.equal(
        bootstrapped.stderr.includes(serviceKey),
        false,
        "stderr must not contain service key",
      );

      async function assertBootstrapOutputsUnchanged() {
        // Compare without including either credential in a test failure.
        const currentPassword = (await readPrivateBootstrapOutput(passwordFile)).trim();
        const currentServiceKey = await readPrivateBootstrapOutput(serviceKeyFile);
        assert.ok(currentPassword === password, "bootstrap password changed");
        assert.ok(currentServiceKey === serviceKeyBytes, "bootstrap service-key output changed");
      }

      // Helm upgrades and Job retries must not rotate the bootstrap credential.
      await runSuccessfulBootstrap(environment, "installation.already-bootstrapped");
      assert.deepEqual(await defaultNamespaceRows(pool), defaultNamespace);
      await assertBootstrapOutputsUnchanged();
      const {
        OCC_BOOTSTRAP_INSTALLATION_NAME,
        OCC_BOOTSTRAP_PASSWORD_FILE,
        OCC_BOOTSTRAP_SERVICE_KEY_FILE,
        ...existingOnlyEnvironment
      } = environment;
      assert.equal(OCC_BOOTSTRAP_INSTALLATION_NAME.length > 0, true);
      assert.equal(OCC_BOOTSTRAP_PASSWORD_FILE.length > 0, true);
      assert.equal(OCC_BOOTSTRAP_SERVICE_KEY_FILE.length > 0, true);
      await runSuccessfulBootstrap(existingOnlyEnvironment, "installation.already-bootstrapped");
      assert.deepEqual(await defaultNamespaceRows(pool), defaultNamespace);
      await assertBootstrapOutputsUnchanged();

      // A different configured administrator must not silently adopt the existing Installation.
      const administratorMismatch = await run(
        process.execPath,
        ["scripts/bootstrap-installation.mjs"],
        {
          cwd: repository,
          env: { ...environment, OCC_BOOTSTRAP_ADMIN_EMAIL: "different-admin@example.test" },
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      assert.ok(administratorMismatch instanceof Error);
      const administratorStderr = text(record(administratorMismatch).stderr);
      const bootstrapFailure = parseLogEvents(administratorStderr).find(
        (line) => line.event === "installation.bootstrap-failed",
      );
      assert.ok(bootstrapFailure, "bootstrap refusal must emit its failure event");
      assert.ok(
        bootstrapFailure.severity === "ERROR" &&
          bootstrapFailure.service === "occ-bootstrap" &&
          bootstrapFailure.code === "BOOTSTRAP_FAILED",
        "bootstrap refusal must identify its service, severity, and failure code",
      );

      const rejectedAdministrator = await pool.query<Record<string, unknown>>(
        'SELECT id FROM occ."user" WHERE email = $1',
        ["different-admin@example.test"],
      );
      assert.equal(rejectedAdministrator.rowCount, 0);

      // Verify persisted Better Auth ownership, the real IAM Principal, and bootstrap audit evidence.
      const installation = await pool.query<Record<string, unknown>>(
        "SELECT id, count(*) OVER()::integer AS count FROM occ.installation",
      );
      assert.equal(installation.rows.length, 1);
      assert.equal(row(installation).count, 1);
      assert.ok(
        serviceKeyMeta.installationId === recordId(row(installation)),
        "bootstrap service key must belong to the installed Installation",
      );
      const user = await pool.query<Record<string, unknown>>(
        `SELECT id, email, email_verified
         FROM occ."user" WHERE email = $1`,
        [adminEmail],
      );
      assert.equal(user.rows.length, 1);
      assert.equal(row(user).email_verified, true);
      const account = await pool.query<Record<string, unknown>>(
        `SELECT provider_id, account_id, password
         FROM occ.account WHERE user_id = $1`,
        [recordId(row(user))],
      );
      assert.equal(account.rows.length, 1);
      assert.equal(row(account).provider_id, "credential");
      assert.equal(row(account).account_id, recordId(row(user)));
      assert.equal(typeof row(account).password, "string");
      assert.ok(row(account).password !== password, "bootstrap password was stored in plaintext");
      const identity = await pool.query<Record<string, unknown>>(
        "SELECT id, kind, issuer, subject FROM occ.iam_identities WHERE subject = $1",
        [recordId(row(user))],
      );
      assert.equal(identity.rows.length, 1);
      assert.equal(row(identity).kind, "principal");
      assert.match(text(row(identity).issuer), /^occ:installation:/);
      const audit = await pool.query<Record<string, unknown>>(
        "SELECT kind, actor_id FROM occ.audit_events WHERE kind = 'bootstrap' AND actor_id = $1",
        [recordId(row(identity))],
      );
      assert.deepEqual(audit.rows, [{ kind: "bootstrap", actor_id: recordId(row(identity)) }]);
      const bootstrapServicePrincipal = await pool.query<Record<string, unknown>>(
        `SELECT identity.id, binding.role_id
         FROM occ.iam_identities identity
         JOIN occ.iam_access_bindings binding ON binding.identity_subject_id = identity.id
         WHERE identity.id = $1
           AND identity.kind = 'service_principal'
           AND identity.namespace_id IS NULL
           AND identity.agent_id IS NULL`,
        [serviceKeyData.servicePrincipalId],
      );
      assert.equal(bootstrapServicePrincipal.rowCount, 1);
      const humanBinding = await pool.query<Record<string, unknown>>(
        `SELECT role_id FROM occ.iam_access_bindings WHERE identity_subject_id = $1`,
        [recordId(row(identity))],
      );
      assert.equal(text(row(bootstrapServicePrincipal).role_id), text(row(humanBinding).role_id));
      const storedServiceKey = await pool.query<Record<string, unknown>>(
        `SELECT key, reference_id, name, metadata
         FROM occ.apikey WHERE id = $1`,
        [text(serviceKeyData.id)],
      );
      assert.equal(storedServiceKey.rowCount, 1);
      assert.ok(
        row(storedServiceKey).key !== serviceKey,
        "bootstrap service key was stored in plaintext",
      );
      assert.ok(
        row(storedServiceKey).reference_id === serviceKeyData.servicePrincipalId,
        "stored bootstrap service key must belong to the bootstrap principal",
      );
      assert.ok(
        row(storedServiceKey).name === "bootstrap-admin",
        "incorrect stored bootstrap service-key name",
      );
      assert.ok(
        isDeepStrictEqual(
          parsePrivateJson(
            text(row(storedServiceKey).metadata),
            "stored bootstrap service-key metadata",
          ),
          {
            installationId: recordId(row(installation)),
          },
        ),
        "stored bootstrap service-key metadata must identify only its Installation",
      );
      const leakedAudit = await pool.query<Record<string, unknown>>(
        `SELECT count(*)::integer AS count
         FROM occ.audit_events
         WHERE details::text LIKE $1 OR details::text LIKE $2 OR details::text LIKE $3`,
        [`%${password}%`, `%${row(account).password}%`, `%${serviceKey}%`],
      );
      assert.equal(row(leakedAudit).count, 0);

      // The application role cannot gain schema ownership through authentication or bootstrap.
      const privileges = await pool.query<Record<string, unknown>>(
        "SELECT has_schema_privilege(current_user, 'occ', 'CREATE') AS can_create_schema",
      );
      assert.equal(row(privileges).can_create_schema, false);

      // Exercise both API builders against PostgreSQL while failures at owned Driver seams
      // verify that shutdown and failed startup still release later owners.
      for (const [mode, failure] of [
        ["production", "shutdown"],
        ["development", "shutdown"],
        ["production", "bind"],
        ["development", "bind"],
        ["production", "routes"],
      ]) {
        await t.test(`${mode} cleanup after ${failure} failure`, async () => {
          const events: string[] = [];
          const first = mode === "production" ? 0 : new Error("first cleanup failure");
          const startup = new Error("original startup failure");
          const runtimeBase = await productionDrivers();
          const registration = {
            ...createProtectedFixture({
              id: "cleanup-fixture",
              implementation: "cleanup-fixture",
              configuration: { endpoint: "https://127.0.0.1:1", ca: "unused" },
            }),
          };
          delete registration.computeLifecycleHooks;
          assert.ok(registration.capabilities.credential_proxy);
          registration.capabilities.credential_proxy.bindExchange = async (connect) => {
            events.push("bind");
            if (failure === "bind") {
              throw startup;
            }
            connect({ verify: async () => undefined, capture: () => undefined, owns: () => false });
            return {
              async close() {
                events.push("exchange");
                throw first;
              },
            };
          };
          registration.close = async () => {
            events.push("driver");
            throw new Error("later cleanup failure");
          };
          const protectedDriver = new InstalledDriver(
            { id: "cleanup-fixture", implementation: "cleanup-fixture", configuration: {} },
            registration,
          );
          const cleanup: { endPool?: () => Promise<void> } = {};
          let poolClosed = false;
          const preparedGitHub = {
            async connect(pool: Pool) {
              const endPool = pool.end.bind(pool);
              cleanup.endPool = endPool;
              pool.end = async () => {
                events.push("pool");
                await endPool();
                poolClosed = true;
              };
            },
            async close() {
              events.push("prepared");
            },
          };
          const runtime = { ...runtimeBase, protectedDriver, preparedGitHub };
          const config = {
            mode,
            host: "127.0.0.1",
            databaseUrl,
            authSecret,
            authBaseURL,
            nativeAdmin,
          };
          const build = () =>
            mode === "production"
              ? composeProduction({
                  ...config,
                  drivers: runtime,
                  onStartupPhase(phase: ProductionStartupPhase) {
                    if (failure === "routes" && phase === "routes") {
                      throw startup;
                    }
                  },
                })
              : composePostgresDevelopment(config, runtime);
          try {
            if (failure === "shutdown") {
              const instance = await build();
              await assert.rejects(
                () => instance.close(),
                (error) =>
                  first === 0
                    ? error instanceof Error &&
                      error.message === "Resource cleanup failed." &&
                      error.cause === first
                    : error === first,
              );
            } else {
              await assert.rejects(build, (error) => error === startup);
            }
            assert.deepEqual(
              events,
              failure === "bind"
                ? ["bind", "driver", "prepared", "pool"]
                : ["bind", "exchange", "driver", "prepared", "pool"],
            );
            assert.equal(poolClosed, true);
          } finally {
            // Release only this case's pool if a regression strands it.
            if (cleanup.endPool && !poolClosed) {
              await cleanup.endPool();
            }
          }
        });
      }

      // The worker owns the same protected Driver and its own pool. A Driver that fails to close
      // must not strand the worker's PostgreSQL connections at shutdown.
      await t.test(
        "worker stop closes its pool after a protected Driver close failure",
        async () => {
          const driverFailure = new Error("protected Driver cleanup failure");
          const runtimeBase = await productionDrivers();
          const registration = {
            ...createProtectedFixture({
              id: "worker-cleanup-fixture",
              implementation: "worker-cleanup-fixture",
              configuration: { endpoint: "https://127.0.0.1:1", ca: "unused" },
            }),
          };
          delete registration.computeLifecycleHooks;
          registration.close = async () => {
            throw driverFailure;
          };
          const protectedDriver = new InstalledDriver(
            {
              id: "worker-cleanup-fixture",
              implementation: "worker-cleanup-fixture",
              configuration: {},
            },
            registration,
          );
          const runtime = { ...runtimeBase, protectedDriver };
          const workerPool = new Pool({ connectionString: databaseUrl });
          const worker = createControllerWorker({
            pool: workerPool,
            mode: "production",
            drivers: runtime,
            pollIntervalMs: 20,
            emit: () => {},
          });
          try {
            await worker.start();
            await assert.rejects(worker.stop(), (error) => error === driverFailure);
            assert.equal(
              workerPool.ended,
              true,
              "the worker pool must close after the Driver fails",
            );
          } finally {
            if (!workerPool.ended) {
              await workerPool.end();
            }
          }
        },
      );

      await t.test("API listen failure survives completed PostgreSQL cleanup", async (t) => {
        const port = await listen(t, createServer());
        // These constructors need settings; no Docker operation runs during this startup.
        setEnvironment(t, {
          OCC_DOCKER_RUNTIME_IMAGE: "unused-startup-fixture",
          OCC_DEVELOPMENT_CONFIGURATION_ROOT: passwordDirectory,
        });
        const signals = ["SIGINT", "SIGTERM"];
        const previous = new Set(signals.flatMap((signal) => process.listeners(signal)));
        t.after(() => {
          for (const signal of signals) {
            for (const listener of process.listeners(signal)) {
              if (!previous.has(listener)) {
                process.removeListener(signal, listener);
              }
            }
          }
        });
        const close = PostgresPlatformState.prototype.close;
        const cleanupError = new Error("unrelated PostgreSQL cleanup error");
        let completed = false;
        const mockedClose = t.mock.method(
          PostgresPlatformState.prototype,
          "close",
          async function (this: PostgresPlatformState) {
            await delay(0);
            await close.call(this);
            completed = true;
            throw cleanupError;
          },
        );
        await assert.rejects(
          startApi({
            NODE_ENV: "development",
            OCC_DATABASE_URL: databaseUrl,
            OCC_HOST: "127.0.0.1",
            OCC_PORT: String(port),
            OCC_AUTH_SECRET: authSecret,
            OCC_AUTH_BASE_URL: authBaseURL,
            OCC_AGENT_NATIVE_ADMIN_DOMAIN: nativeAdmin.domain,
          }),
          (error) => error !== cleanupError && record(error).code === "EADDRINUSE",
        );
        assert.equal(mockedClose.mock.callCount(), 1);
        assert.equal(completed, true, "startup must await the real pool close");
      });

      const apiLog = memoryLog();
      const startupPhases: { phase: ProductionStartupPhase; durationMs: number }[] = [];
      app = await composeProduction({
        mode: "production",
        host: "127.0.0.1",
        databaseUrl,
        authSecret,
        authBaseURL,
        nativeAdmin,
        onStartupPhase: (phase: ProductionStartupPhase, durationMs: number) =>
          startupPhases.push({ phase, durationMs }),
        drivers: await productionDrivers({
          includeDefaults: true,
          configurationRoot: join(passwordDirectory, "configurations"),
        }),
        logger: apiLog.logger,
      });
      assert.deepEqual(
        records(apiLog.lines)
          .filter(({ event }) => event === "compute.preflight-warning")
          .map(({ event, severity, computeDriverId, code, message }) => ({
            event,
            severity,
            computeDriverId,
            code,
            message,
          })),
        [
          {
            event: "compute.preflight-warning",
            severity: "WARN",
            computeDriverId: "compute-production-wireup",
            code: "KUBERNETES_VERSION_BELOW_MINIMUM",
            message: "Kubernetes 1.34.12 is below the supported minimum 1.35.0.",
          },
        ],
        "production API composition must emit the Compute warning and continue startup",
      );
      // The API's `listening` line reports these, so an operator can see which phase was slow.
      assert.deepEqual(
        startupPhases.map(({ phase }) => phase),
        ["database", "identity", "computePreflight", "authentication", "controller", "routes"],
      );
      assert.ok(startupPhases.every(({ durationMs }) => Number.isSafeInteger(durationMs)));
      endpoint = await app.listen({ port: 0, host: "127.0.0.1" });

      await assert.rejects(
        signInWithEmailPassword({
          origin: endpoint,
          path: "/api/auth/sign-in/email",
          email: adminEmail,
          password: `${password}-wrong`,
        }),
        /HTTP 401/,
      );
      const session = await signInWithEmailPassword({
        origin: endpoint,
        path: "/api/auth/sign-in/email",
        email: adminEmail,
        password,
      });
      assert.ok(
        /(?:^|; )__Secure-openclaw_occ_shared\.session_token=/.test(session.cookie),
        "sign-in must set the secure session cookie",
      );
      assert.ok(
        /Domain=oce\.localhost/i.test(session.setCookie.join("\n")),
        "incorrect session cookie domain",
      );

      const anonymousSession = await fetch(`${endpoint}/api/auth/session`);
      assert.equal(anonymousSession.status, 200);
      assert.ok(
        record(parsePrivateJson(await anonymousSession.text(), "anonymous session response"))
          .data === null,
        "anonymous session response must have no session data",
      );

      // The optional session endpoint must never turn its HttpOnly cookie into a readable bearer token.
      const sessionResponse = await fetch(`${endpoint}/api/auth/session`, {
        headers: authenticatedHeaders(session),
      });
      assert.equal(sessionResponse.status, 200);
      const visibleSession = await sessionResponse.text();
      const activeSession = await pool.query<Record<string, unknown>>(
        "SELECT token FROM occ.session WHERE user_id = $1",
        [recordId(row(user))],
      );
      assert.equal(activeSession.rows.length, 1);
      assert.ok(
        !/token|password|credential/i.test(visibleSession),
        "session response exposed credential fields",
      );
      assert.equal(visibleSession.includes(text(row(activeSession).token)), false);
      assert.equal(visibleSession.includes(session.cookie), false);

      const authorized = await fetch(`${endpoint}/installation`, {
        headers: authenticatedHeaders(session),
      });
      assert.equal(authorized.status, 200);
      async function assertBootstrapInstallationResponse(response: Response) {
        const payload = record(parsePrivateJson(await response.text(), "installation response"));
        assert.ok(
          recordId(payload.data) === recordId(row(installation)),
          "credential must authorize the bootstrapped Installation",
        );
      }
      await assertBootstrapInstallationResponse(authorized);
      function requestWithBootstrapKey(path: "/installation" | "/namespaces", init: RequestInit) {
        // The credential belongs only to this disposable loopback Controller.
        const address = new URL(endpoint);
        assert.equal(address.protocol, "http:");
        assert.equal(address.hostname, "127.0.0.1");
        const headers = new Headers(init.headers);
        headers.set("x-api-key", serviceKey);
        return fetchLoopback(new URL(path, address).href, {
          ...init,
          headers,
          signal: AbortSignal.timeout(5000),
        });
      }
      const serviceAuthorized = await requestWithBootstrapKey("/installation", { method: "GET" });
      assert.equal(serviceAuthorized.status, 200);
      await assertBootstrapInstallationResponse(serviceAuthorized);

      // Prove all production ServiceAccount grants through the real cookie-authenticated HTTP boundary.
      const request: Request = async (method, path, payload, caller = session) => {
        const response = await fetch(`${endpoint}${path}`, {
          method,
          headers: authenticatedHeaders(caller, {
            // Browser mutations use the configured HTTPS origin over private loopback transport.
            origin: authBaseURL,
            ...(payload === undefined ? {} : { "content-type": "application/json" }),
          }),
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        });
        return {
          status: response.status,
          ...(response.status === 204
            ? {}
            : {
                data: record(parsePrivateJson(await response.text(), "Controller response")).data,
              }),
        };
      };

      const presetPath = `/namespaces/${defaultNamespaceId}/presets`;
      const defaults = await request("GET", presetPath);
      assert.equal(defaults.status, 200);
      assert.deepEqual(
        records(defaults.data)
          .map((preset) => preset.name)
          .sort(),
        ["Standard Codex", "Standard OpenClaw", "default-codex"],
      );
      // The list returns summaries; the exact read carries each template.
      const exactPreset = async (summary: Record<string, unknown> | undefined) =>
        summary && record((await request("GET", `${presetPath}/${recordId(summary)}`)).data);
      const copied = await exactPreset(
        records(defaults.data).find((preset) => preset.name === "Standard Codex"),
      );
      const copiedOpenClaw = await exactPreset(
        records(defaults.data).find((preset) => preset.name === "Standard OpenClaw"),
      );
      assert.ok(copied, "missing Standard Codex");
      assert.ok(copiedOpenClaw, "missing Standard OpenClaw");
      const worker = createControllerWorker({
        pool: new Pool({ connectionString: databaseUrl }),
        mode: "production",
        drivers: await productionDrivers(),
        pollIntervalMs: 20,
        emit: () => {},
      });
      try {
        await worker.start();
        await waitUntil(
          "the default Namespace to become ready",
          async () =>
            record((await request("GET", `/namespaces/${defaultNamespaceId}`)).data).status ===
            "ready",
        );
      } finally {
        await worker.stop();
      }
      // Production composition must retain the same contract-sized route budget as development.
      const workspaceContent = (
        "# Workspace guidance\n" + "Routine fixture instructions.\n".repeat(600)
      ).slice(0, 16 * 1024);
      const workspaceTemplate = {
        agent: {
          initialWorkspaceFiles: Object.fromEntries(
            ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"].map((name) => [
              name,
              workspaceContent,
            ]),
          ),
        },
      };
      const largePreset = await request("POST", presetPath, {
        name: "Full workspace",
        template: workspaceTemplate,
      });
      assert.equal(largePreset.status, 201);
      const replacedPreset = await request("PATCH", `${presetPath}/${recordId(largePreset.data)}`, {
        name: "Full workspace updated",
        template: workspaceTemplate,
      });
      assert.equal(replacedPreset.status, 200);
      assert.deepEqual(
        record((await request("GET", `${presetPath}/${recordId(largePreset.data)}`)).data).template,
        workspaceTemplate,
      );
      assert.equal(
        (await request("DELETE", `${presetPath}/${recordId(largePreset.data)}`)).status,
        204,
      );

      const customized = await request("PATCH", `${presetPath}/${recordId(copied)}`, {
        template: { agent: { name: "Kept across restart" } },
      });
      assert.equal(customized.status, 200);
      // Roll Standard OpenClaw back to an earlier shipped version, as a Namespace seeded
      // by that release holds it. The restart below must refresh it in place.
      const archivedPreset = async (path: string) =>
        record(
          json(
            await readFile(
              new URL(`../../deploy/presets/archive/${path}`, import.meta.url),
              "utf8",
            ),
          ),
        );
      const earlierOpenClaw = await archivedPreset("standard-openclaw/ed4bae5153f86b94.json");
      const rolledBack = await request("PATCH", `${presetPath}/${recordId(copiedOpenClaw)}`, {
        template: earlierOpenClaw.template,
      });
      assert.equal(rolledBack.status, 200);
      assert.notDeepEqual(record(rolledBack.data).template, copiedOpenClaw.template);
      const restart = async (
        drivers: DriverOptions,
        logger?: ReturnType<typeof memoryLog>["logger"],
      ) => {
        assert.ok(app);
        await app.close();
        app = await composeProduction({
          mode: "production",
          host: "127.0.0.1",
          databaseUrl,
          authSecret,
          authBaseURL,
          nativeAdmin,
          drivers: await productionDrivers({
            ...drivers,
            configurationRoot: join(passwordDirectory, "configurations"),
          }),
          ...(logger === undefined ? {} : { logger }),
        });
        endpoint = await app.listen({ port: 0, host: "127.0.0.1" });
      };
      const readOpenClaw = async () =>
        (await request("GET", `${presetPath}/${recordId(copiedOpenClaw)}`)).data;
      // The same file seeded through presets.files, with includeDefaults off, is never refreshed.
      await restart({
        includeDefaults: false,
        files: [
          fileURLToPath(new URL("../../deploy/presets/standard-openclaw.json", import.meta.url)),
        ],
      });
      assert.deepEqual(await readOpenClaw(), rolledBack.data);
      await restart({ includeDefaults: true });
      const afterRestart = await request("GET", presetPath);
      assert.deepEqual(
        records(afterRestart.data)
          .map((preset) => preset.name)
          .sort(),
        ["Standard Codex", "Standard OpenClaw", "default-codex"],
      );
      assert.deepEqual(
        await exactPreset(
          records(afterRestart.data).find((preset) => preset.name === "Standard Codex"),
        ),
        customized.data,
      );
      // Refreshed from the stored JSONB: same ID, current template. The edit above stays.
      assert.deepEqual(
        await exactPreset(
          records(afterRestart.data).find((preset) => preset.name === "Standard OpenClaw"),
        ),
        copiedOpenClaw,
      );
      // A Restriction freezing the Namespace's Presets keeps an earlier copy, and startup
      // only warns. It stays for the rest of this test, which never updates these Presets.
      const refrozen = await request("PATCH", `${presetPath}/${recordId(copiedOpenClaw)}`, {
        template: earlierOpenClaw.template,
      });
      assert.equal(refrozen.status, 200);
      const freezeId = `freeze-presets-${randomUUID()}`;
      await pool.query<Record<string, unknown>>(
        "INSERT INTO occ.iam_restrictions (id, namespace_id, action, resource_kind) VALUES ($1, $2, 'update', 'preset')",
        [freezeId, defaultNamespaceId],
      );
      const skippedRefreshes = ({ lines }: ReturnType<typeof memoryLog>) =>
        records(lines)
          .filter(({ event }) => event === "presets.default-refresh-skipped")
          .map(({ severity, namespaceId, presetId, presetName, reason, restrictionIds }) => ({
            severity,
            namespaceId,
            presetId,
            presetName,
            reason,
            restrictionIds,
          }));
      const frozenWarning = [
        {
          severity: "WARN",
          namespaceId: defaultNamespaceId,
          presetId: copiedOpenClaw.id,
          presetName: "Standard OpenClaw",
          reason: "An applicable Restriction denies the exact action and resource.",
          restrictionIds: [freezeId],
        },
      ];
      const frozenLog = memoryLog();
      await restart({ includeDefaults: true }, frozenLog.logger);
      assert.deepEqual(await readOpenClaw(), refrozen.data);
      assert.deepEqual(skippedRefreshes(frozenLog), frozenWarning);
      // Development PostgreSQL startup passes the same warning to its logger.
      const developmentLog = memoryLog();
      const { gateway } = createDeviceCredentialDrivers();
      const withSourceToken = t.mock.fn(() => {
        assert.fail("PostgreSQL development startup must not read a plugin credential");
      });
      const pluginSourceReader = { gateway, withSourceToken };
      const developmentRuntime = {
        ...(await productionDrivers({
          includeDefaults: true,
          configurationRoot: join(passwordDirectory, "configurations"),
        })),
        pluginSourceReader,
      };
      const factory = t.mock.method(OpenClawController, "forInstallation");
      let development: Awaited<ReturnType<typeof composePostgresDevelopment>> | undefined;
      try {
        development = await composePostgresDevelopment(
          {
            mode: "development",
            host: "127.0.0.1",
            databaseUrl,
            authSecret,
            authBaseURL,
            nativeAdmin,
            logger: developmentLog.logger,
          },
          developmentRuntime,
        );
        assert.equal(factory.mock.callCount(), 1);
        const factoryCall = factory.mock.calls[0];
        assert.ok(factoryCall);
        const [persistedInstallation, controllerOptions] = factoryCall.arguments;
        assert.equal(persistedInstallation.id, recordId(row(installation)));
        assert.ok(controllerOptions.state instanceof PostgresPlatformState);
        assert.strictEqual(
          controllerOptions.pluginSourceReader,
          pluginSourceReader,
          "PostgreSQL development must forward the identical plugin source reader",
        );
        assert.equal(withSourceToken.mock.callCount(), 0);
      } finally {
        factory.mock.restore();
        await development?.close();
      }
      assert.deepEqual(await readOpenClaw(), refrozen.data);
      assert.deepEqual(skippedRefreshes(developmentLog), frozenWarning);
      // An operator file named like a bundled default (default-codex was bundled after
      // operators could already use the name) replaces it: startup warns instead of stopping.
      const operatorCodexPath = join(passwordDirectory, "operator-default-codex.json");
      const operatorCodexTemplate = {
        agent: { name: "Operator Codex", executionMode: "dedicated" },
      };
      await writeFile(
        operatorCodexPath,
        JSON.stringify({ name: "default-codex", template: operatorCodexTemplate }),
      );
      const bundledCodexCopy = async () =>
        exactPreset(
          records((await request("GET", presetPath)).data).find(
            (preset) => preset.name === "default-codex",
          ),
        );
      const seededCodex = await bundledCodexCopy();
      const shadowLog = memoryLog();
      await restart({ includeDefaults: true, files: [operatorCodexPath] }, shadowLog.logger);
      // The copy seeded earlier from the bundled template stays as it was.
      assert.deepEqual(await bundledCodexCopy(), seededCodex);
      assert.deepEqual(
        records(shadowLog.lines)
          .filter(({ event }) => event === "presets.bundled-default-shadowed")
          .map(({ severity, presetName, presetFile }) => ({ severity, presetName, presetFile })),
        [{ severity: "WARN", presetName: "default-codex", presetFile: operatorCodexPath }],
      );
      const newNamespace = await request("POST", "/namespaces", {
        name: "Preset startup namespace",
      });
      assert.equal(newNamespace.status, 201);
      const newPresets = await request("GET", `/namespaces/${recordId(newNamespace.data)}/presets`);
      assert.deepEqual(
        records(newPresets.data)
          .map((preset) => preset.name)
          .sort(),
        ["Standard Codex", "Standard OpenClaw", "default-codex"],
      );
      // A new Namespace receives the operator's template, not the bundled one. The list
      // returns summaries, so read the exact Preset for its template.
      const newCodex = records(newPresets.data).find((preset) => preset.name === "default-codex");
      assert.ok(newCodex);
      const newCodexPreset = await request(
        "GET",
        `/namespaces/${recordId(newNamespace.data)}/presets/${recordId(newCodex)}`,
      );
      assert.equal(
        record(record(record(newCodexPreset.data).template).agent).name,
        operatorCodexTemplate.agent.name,
      );
      assert.notEqual(
        recordId(records(newPresets.data).find((preset) => preset.name === "Standard Codex")),
        copied.id,
      );
      assert.notEqual(
        recordId(records(newPresets.data).find((preset) => preset.name === "Standard OpenClaw")),
        copiedOpenClaw.id,
      );
      // An earlier release seeded this default under a name the bundle no longer ships.
      // The Namespace is still provisioning, so write the row as that seeding did.
      const earlierCodex = await archivedPreset("standard-codex/a07d1e2070d95c99.json");
      await pool.query<Record<string, unknown>>(
        "INSERT INTO occ.presets (id, namespace_id, name, template, created_at) VALUES ($1, $2, $3, $4, now())",
        [
          `pre_${randomUUID()}`,
          recordId(newNamespace.data),
          earlierCodex.name,
          JSON.stringify(
            normalizePresetTemplate(earlierCodex.template, recordId(newNamespace.data)),
          ),
        ],
      );
      // Only unmodified seeded defaults remain, so deletion removes them with the Namespace.
      const deletedNamespace = await request(
        "DELETE",
        `/namespaces/${recordId(newNamespace.data)}`,
      );
      assert.equal(deletedNamespace.status, 202);
      assert.equal(record(deletedNamespace.data).status, "deleting");
      const remainingPresets = await pool.query<Record<string, unknown>>(
        "SELECT id FROM occ.presets WHERE namespace_id = $1",
        [recordId(newNamespace.data)],
      );
      assert.deepEqual(remainingPresets.rows, []);

      const defaultConfiguration = await request(
        "POST",
        `/namespaces/${defaultNamespaceId}/configurations`,
        {
          kind: "agent",
          values: { model: "preserved-default" },
        },
      );
      assert.equal(defaultConfiguration.status, 201);
      const defaultAgent = await request("POST", `/namespaces/${defaultNamespaceId}/agents`, {
        name: `default-agent-${randomUUID()}`,
        configurationId: recordId(defaultConfiguration.data),
      });
      assert.equal(defaultAgent.status, 201);
      const persistedDefaultNamespace = await request("GET", `/namespaces/${defaultNamespaceId}`);
      assert.equal(persistedDefaultNamespace.status, 200);
      const persistedDefaultConfiguration = await request(
        "GET",
        `/namespaces/${defaultNamespaceId}/configurations/${recordId(defaultConfiguration.data)}`,
      );
      assert.equal(persistedDefaultConfiguration.status, 200);
      assert.deepEqual(record(persistedDefaultConfiguration.data).values, {
        model: "preserved-default",
      });
      const persistedDefaultAgent = await request(
        "GET",
        `/namespaces/${defaultNamespaceId}/agents/${recordId(defaultAgent.data)}`,
      );
      assert.equal(persistedDefaultAgent.status, 200);
      assert.equal(
        record(persistedDefaultAgent.data).configurationId,
        recordId(defaultConfiguration.data),
      );
      await runSuccessfulBootstrap(existingOnlyEnvironment, "installation.already-bootstrapped");
      assert.deepEqual(
        await defaultNamespaceRows(pool),
        defaultNamespace.map((namespace) => ({ ...namespace, status: "ready" })),
      );
      assert.deepEqual(
        await request("GET", `/namespaces/${defaultNamespaceId}`),
        persistedDefaultNamespace,
      );
      assert.deepEqual(
        await request(
          "GET",
          `/namespaces/${defaultNamespaceId}/configurations/${recordId(defaultConfiguration.data)}`,
        ),
        persistedDefaultConfiguration,
      );
      assert.deepEqual(
        await request(
          "GET",
          `/namespaces/${defaultNamespaceId}/agents/${recordId(defaultAgent.data)}`,
        ),
        persistedDefaultAgent,
      );

      const namespace = await request("POST", "/namespaces", {
        name: `production-service-account-${randomUUID()}`,
      });
      assert.equal(namespace.status, 201);
      const accountsPath = `/namespaces/${recordId(namespace.data)}/service-accounts`;
      const createdAccount = await request("POST", accountsPath, {
        name: "production-model-provider",
      });
      assert.equal(createdAccount.status, 201);
      const accountPath = `${accountsPath}/${recordId(createdAccount.data)}`;
      assert.deepEqual((await request("GET", accountPath)).data, createdAccount.data);
      const credential = {
        kind: "api_key",
        secretRef: { name: "production-model-source", key: "provider-api-key" },
      };
      const updatedAccount = await request("PATCH", `${accountPath}/credential`, credential);
      assert.equal(updatedAccount.status, 200);
      assert.deepEqual(updatedAccount.data, {
        ...record(createdAccount.data),
        credential: { kind: credential.kind },
      });
      const visibleAccount = await request("GET", accountPath);
      assert.deepEqual(visibleAccount, updatedAccount);
      for (const response of [updatedAccount, visibleAccount]) {
        assert.equal(JSON.stringify(response).includes(credential.secretRef.name), false);
        assert.equal(JSON.stringify(response).includes(credential.secretRef.key), false);
      }
      assert.equal((await request("DELETE", accountPath)).status, 204);
      assert.equal((await request("GET", accountPath)).status, 404);
      const serviceNamespace = await requestWithBootstrapKey("/namespaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `bootstrap-admin-key-${randomUUID()}` }),
      });
      assert.equal(serviceNamespace.status, 201);

      const bearer = await fetch(`${endpoint}/installation`, {
        headers: { authorization: "Bearer no-longer-supported" },
      });
      assert.equal(bearer.status, 401);

      const publicSignup = await fetch(`${endpoint}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "public@example.test",
          password: "public-signup-disabled",
          name: "Public",
        }),
      });
      assert.equal(publicSignup.status, 404);

      await t.test(
        "persisted sharing follows real cookie sessions across restart and revocation",
        async (sharingTest) => {
          assert.ok(pool);
          await runSharingCases(sharingTest, {
            pool,
            request,
            signInWithEmailPassword,
            productionDrivers,
            apiLog,
            databaseUrl,
            authSecret,
            authBaseURL,
            nativeAdmin,
            adminEmail,
            password,
            namespaceId: defaultNamespaceId,
            agentId: recordId(defaultAgent.data),
            configurationId: recordId(defaultConfiguration.data),
            get app() {
              assert.ok(app);
              return app;
            },
            set app(value) {
              app = value;
            },
            get endpoint() {
              return endpoint;
            },
            set endpoint(value) {
              endpoint = value;
            },
          });
        },
      );
    } finally {
      if (app !== undefined) {
        await app.close();
      }
      if (pool !== undefined) {
        await pool.end();
      }
    }
  },
);
