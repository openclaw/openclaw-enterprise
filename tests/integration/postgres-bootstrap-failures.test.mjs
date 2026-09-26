import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { composePostgresDevelopment } from "../../apps/controller/src/composition/development-postgres.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { admittedLoggingLevel } from "../../packages/contracts/src/index.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import {
  developmentBootstrapEnvironment,
  productionBootstrapEnvironment,
  runBootstrapInstallation,
} from "../helpers/bootstrap-installation.mjs";

const failureDatabaseUrl = process.env.OCC_BOOTSTRAP_FAILURE_DATABASE_URL;
const commitAcknowledgementFaultFixture = fileURLToPath(
  new URL("../fixtures/postgres-commit-ack-fault.mjs", import.meta.url),
);
const requiresFailurePostgres = {
  skip: failureDatabaseUrl
    ? false
    : "Set OCC_BOOTSTRAP_FAILURE_DATABASE_URL to a migrated disposable PostgreSQL failure database.",
};
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);

const RESET_TABLES = [
  "occ.session",
  "occ.account",
  "occ.apikey",
  "occ.verification",
  'occ."user"',
  "occ.controller_work",
  "occ.audit_events",
  "occ.agent_revisions",
  "occ.agents",
  "occ.configurations",
  "occ.secrets",
  "occ.service_account_driver_bindings",
  "occ.service_accounts",
  "occ.namespaces",
  "occ.iam_access_bindings",
  "occ.iam_group_memberships",
  "occ.iam_groups",
  "occ.iam_restrictions",
  "occ.iam_roles",
  "occ.iam_identities",
  "occ.installation",
].join(", ");

function migratorDatabaseUrl() {
  const application = validatedFailureDatabaseUrl();
  const explicit = process.env.OCC_BOOTSTRAP_FAILURE_MIGRATION_DATABASE_URL;
  if (explicit !== undefined && explicit.trim().length > 0) {
    const migration = new URL(explicit);
    if (
      migration.hostname !== application.hostname ||
      migration.port !== application.port ||
      migration.pathname !== application.pathname
    ) {
      throw new Error(
        "OCC_BOOTSTRAP_FAILURE_MIGRATION_DATABASE_URL must target the same host, port, and database as OCC_BOOTSTRAP_FAILURE_DATABASE_URL.",
      );
    }
    return explicit;
  }
  const parsed = new URL(application);
  if (parsed.username !== "occ_app") {
    throw new Error(
      "OCC_BOOTSTRAP_FAILURE_MIGRATION_DATABASE_URL must be set when the failure database URL does not use the local occ_app role.",
    );
  }
  parsed.username = "occ_migrator";
  parsed.password = "occ-migrator-local";
  return parsed.toString();
}

function validatedFailureDatabaseUrl() {
  const parsed = new URL(failureDatabaseUrl);
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("OCC_BOOTSTRAP_FAILURE_DATABASE_URL must be a PostgreSQL URL.");
  }
  if (!loopbackHosts.has(parsed.hostname)) {
    throw new Error("OCC_BOOTSTRAP_FAILURE_DATABASE_URL must target loopback PostgreSQL.");
  }
  const database = parsed.pathname.replace(/^\//, "");
  if (!database.startsWith("openclaw_failures_")) {
    throw new Error(
      "OCC_BOOTSTRAP_FAILURE_DATABASE_URL must target a dedicated openclaw_failures_* database.",
    );
  }
  return parsed;
}

async function withPool(databaseUrl, operation) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  try {
    return await operation(pool);
  } finally {
    await pool.end();
  }
}

async function resetFailureDatabase() {
  validatedFailureDatabaseUrl();
  await withPool(migratorDatabaseUrl(), async (pool) => {
    await pool.query("DROP TRIGGER IF EXISTS bootstrap_known_failure ON occ.installation");
    await pool.query("DROP FUNCTION IF EXISTS occ.bootstrap_known_failure()");
    await pool.query("DROP TRIGGER IF EXISTS bootstrap_failure_delay ON occ.installation");
    await pool.query("DROP FUNCTION IF EXISTS occ.bootstrap_failure_delay()");
    await pool.query(`TRUNCATE ${RESET_TABLES} RESTART IDENTITY CASCADE`);
  });
}

async function installKnownInstallationFailure() {
  validatedFailureDatabaseUrl();
  await withPool(migratorDatabaseUrl(), async (pool) => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION occ.bootstrap_known_failure() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced bootstrap insert failure';
      END;
      $$
    `);
    await pool.query(`
      CREATE TRIGGER bootstrap_known_failure
      BEFORE INSERT ON occ.installation
      FOR EACH ROW EXECUTE FUNCTION occ.bootstrap_known_failure()
    `);
  });
}

async function installInstallationDelay() {
  validatedFailureDatabaseUrl();
  await withPool(migratorDatabaseUrl(), async (pool) => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION occ.bootstrap_failure_delay() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(0.35);
        RETURN NEW;
      END;
      $$
    `);
    await pool.query("DROP TRIGGER IF EXISTS bootstrap_failure_delay ON occ.installation");
    await pool.query(`
      CREATE TRIGGER bootstrap_failure_delay
      BEFORE INSERT ON occ.installation
      FOR EACH ROW EXECUTE FUNCTION occ.bootstrap_failure_delay()
    `);
  });
}

async function rowCounts() {
  return withPool(failureDatabaseUrl, async (pool) => {
    const result = await pool.query(`
      SELECT
        (SELECT count(*)::integer FROM occ.installation) AS installations,
        (SELECT count(*)::integer FROM occ.audit_events WHERE kind = 'bootstrap') AS bootstrap_audits,
        (SELECT count(*)::integer FROM occ.iam_identities WHERE kind = 'principal') AS principals,
        (SELECT count(*)::integer FROM occ.iam_identities WHERE kind = 'service_principal') AS service_principals,
        (SELECT count(*)::integer FROM occ.iam_access_bindings) AS bindings,
        (SELECT count(*)::integer FROM occ.apikey) AS service_keys,
        (SELECT count(*)::integer FROM occ."user") AS users,
        (SELECT count(*)::integer FROM occ.namespaces) AS namespaces,
        (SELECT count(*)::integer FROM occ.controller_work) AS namespace_work
    `);
    return result.rows[0];
  });
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function privateOutputDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await chmod(directory, 0o700);
  return directory;
}

function productionEnvironment({ databaseUrl = failureDatabaseUrl, directory, email, name }) {
  return productionBootstrapEnvironment({
    databaseUrl,
    directory,
    email,
    authSecret: "bootstrap-failure-auth-secret-at-least-32-bytes",
    installationName: name,
  });
}

function developmentEnvironment({ directory, email, name }) {
  return developmentBootstrapEnvironment({
    databaseUrl: failureDatabaseUrl,
    directory,
    email,
    password: "postgres-local-development-password",
    authSecret: "openclaw-postgres-local-auth-secret-minimum-32-bytes",
    installationName: name,
  });
}

async function runProductionBootstrap(environment) {
  return runBootstrapInstallation(environment);
}

function jsonLines(output) {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line));
}

async function request(app, method, url, apiKey, body) {
  const response = await app.inject({
    method,
    url,
    headers: { "x-api-key": apiKey, host: "127.0.0.1" },
    ...(body === undefined ? {} : { payload: body }),
  });
  const parsed = response.body.length === 0 ? undefined : response.json();
  return { status: response.statusCode, body: parsed };
}

async function markNamespaceReady(namespaceId) {
  await withPool(failureDatabaseUrl, async (pool) => {
    await pool.query("UPDATE occ.namespaces SET status = 'ready' WHERE id = $1", [namespaceId]);
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function passiveComputeDriver() {
  const harnessAuthDriver = createTestKubernetesComputeDriver(
    "compute-bootstrap-failure-passive-auth",
  );

  return {
    id: "compute-bootstrap-failure-passive",
    capability: "compute",
    implementation: "bootstrap-failure-passive",
    validateHarnessAuth: harnessAuthDriver.validateHarnessAuth.bind(harnessAuthDriver),
    async preflight() {},
    async ensureNamespace(namespace) {
      return { namespaceId: namespace.id, status: "ready" };
    },
    async deleteNamespace(namespace) {
      return { namespaceId: namespace.id, status: "deleted" };
    },
    async prepareRevision(revision) {
      return { revisionId: revision.id, ready: true };
    },
    async retireRevision() {},
  };
}

for (const sharedOutput of [false, true]) {
  test(
    `concurrent production bootstrap subprocesses ${sharedOutput ? "with shared output paths" : "with separate output paths"} commit at most one seed`,
    requiresFailurePostgres,
    async (context) => {
      await resetFailureDatabase();
      await installInstallationDelay();
      const directories = [
        await privateOutputDirectory("openclaw-bootstrap-race-a-"),
        sharedOutput ? undefined : await privateOutputDirectory("openclaw-bootstrap-race-b-"),
      ];
      directories[1] ??= directories[0];
      context.after(async () => {
        await resetFailureDatabase();
        await Promise.all(
          [...new Set(directories)].map((directory) =>
            rm(directory, { recursive: true, force: true }),
          ),
        );
      });

      const environments = directories.map((directory, index) =>
        productionEnvironment({
          directory,
          email: `bootstrap-race-${index}-${randomUUID()}@example.test`,
          name: `Bootstrap race ${index}`,
        }),
      );

      const results = await Promise.all(environments.map((env) => runProductionBootstrap(env)));
      const successful = results.filter(
        (result) =>
          result.ok &&
          jsonLines(result.stdout).some((line) => line.event === "installation.bootstrapped"),
      );
      const failed = results.filter((result) => !successful.includes(result));
      assert.equal(successful.length, 1, JSON.stringify(results));
      assert.equal(failed.length, 1, JSON.stringify(results));
      const failedEvent = jsonLines(failed[0].stderr).find(
        (line) => line.event === "installation.bootstrap-failed",
      );
      assert.ok(failedEvent, failed[0].stderr);

      const winner = jsonLines(successful[0].stdout).find(
        (line) => line.event === "installation.bootstrapped",
      );
      assert.ok(winner);
      assert.ok(failedEvent.attempt, failed[0].stderr);
      const counts = await rowCounts();
      assert.deepEqual(
        {
          installations: counts.installations,
          bootstrap_audits: counts.bootstrap_audits,
          principals: counts.principals,
          service_principals: counts.service_principals,
          bindings: counts.bindings,
          namespaces: counts.namespaces,
          namespace_work: counts.namespace_work,
        },
        {
          installations: 1,
          bootstrap_audits: 1,
          principals: 1,
          service_principals: 1,
          bindings: 2,
          namespaces: 1,
          namespace_work: 1,
        },
      );
      const winnerIndex = environments.findIndex(
        (environment) => environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE === winner.serviceKeyFile,
      );
      assert.notEqual(winnerIndex, -1);
      const loserIndex = winnerIndex === 0 ? 1 : 0;
      const loserCreatedServiceKey =
        !sharedOutput && (await exists(environments[loserIndex].OCC_BOOTSTRAP_SERVICE_KEY_FILE));
      if (sharedOutput) {
        assert.ok([1, 2].includes(counts.service_keys));
        assert.ok([1, 2].includes(counts.users));
      } else {
        assert.equal(counts.service_keys, loserCreatedServiceKey ? 2 : 1);
        assert.equal(counts.users, loserCreatedServiceKey ? 2 : 1);
      }
      const outputEnvironment = sharedOutput ? environments[0] : environments[winnerIndex];
      assert.equal(await exists(outputEnvironment.OCC_BOOTSTRAP_PASSWORD_FILE), true);
      assert.equal(await exists(outputEnvironment.OCC_BOOTSTRAP_SERVICE_KEY_FILE), true);
      const output = JSON.parse(
        await readFile(outputEnvironment.OCC_BOOTSTRAP_SERVICE_KEY_FILE, "utf8"),
      );
      assert.equal(output.meta.installationId, winner.installationId);
      assert.equal(output.data.servicePrincipalId, winner.servicePrincipalId);
      assert.equal(output.data.id, winner.serviceKeyId);

      for (const [index, environment] of environments.entries()) {
        if (index === winnerIndex || sharedOutput) {
          continue;
        }
        assert.equal(await exists(environment.OCC_BOOTSTRAP_PASSWORD_FILE), loserCreatedServiceKey);
        assert.equal(
          await exists(environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE),
          loserCreatedServiceKey,
        );
      }
    },
  );
}

test(
  "concurrent development bootstrap subprocesses reject the loser and reload the committed winner",
  requiresFailurePostgres,
  async (context) => {
    await resetFailureDatabase();
    await installInstallationDelay();
    const directories = [
      await privateOutputDirectory("openclaw-development-race-a-"),
      await privateOutputDirectory("openclaw-development-race-b-"),
    ];
    const apps = [];
    context.after(async () => {
      await Promise.all(apps.map((app) => app.close()));
      await resetFailureDatabase();
      await Promise.all(
        directories.map((directory) => rm(directory, { recursive: true, force: true })),
      );
    });

    const environments = directories.map((directory, index) =>
      developmentEnvironment({
        directory,
        email: `development-race-${index}-${randomUUID()}@openclaw.local`,
        name: `Development bootstrap race ${index}`,
      }),
    );
    const results = await Promise.all(environments.map((env) => runBootstrapInstallation(env)));
    const fulfilled = results.filter(
      (result) =>
        result.ok &&
        jsonLines(result.stdout).some((line) => line.event === "installation.bootstrapped"),
    );
    const rejected = results.filter((result) => !fulfilled.includes(result));
    assert.equal(fulfilled.length, 1, JSON.stringify(results));
    assert.equal(rejected.length, 1, JSON.stringify(results));
    const rejectedEvent = jsonLines(rejected[0].stderr).find(
      (line) => line.event === "installation.bootstrap-failed",
    );
    assert.ok(rejectedEvent, rejected[0].stderr);

    const winnerIndex = results.findIndex((result) => fulfilled.includes(result));
    const loserIndex = winnerIndex === 0 ? 1 : 0;
    const winnerOutputBytes = await readFile(
      environments[winnerIndex].OCC_BOOTSTRAP_SERVICE_KEY_FILE,
      "utf8",
    );
    const winnerOutputDigest = sha256(winnerOutputBytes);
    const winnerOutput = JSON.parse(winnerOutputBytes);
    assert.ok(rejectedEvent.attempt, rejected[0].stderr);
    const loserCreatedServiceKey = await exists(
      environments[loserIndex].OCC_BOOTSTRAP_SERVICE_KEY_FILE,
    );

    const counts = await rowCounts();
    assert.deepEqual(
      {
        installations: counts.installations,
        bootstrap_audits: counts.bootstrap_audits,
        principals: counts.principals,
        service_principals: counts.service_principals,
        bindings: counts.bindings,
        namespaces: counts.namespaces,
        namespace_work: counts.namespace_work,
      },
      {
        installations: 1,
        bootstrap_audits: 1,
        principals: 1,
        service_principals: 1,
        bindings: 2,
        namespaces: 1,
        namespace_work: 1,
      },
    );
    assert.equal(counts.service_keys, loserCreatedServiceKey ? 2 : 1);
    assert.equal(counts.users, loserCreatedServiceKey ? 2 : 1);

    const driverConfiguration = { ...createInstallationDriverConfiguration(), backend: [] };
    const reloaded = await composePostgresDevelopment(
      {
        mode: "development",
        host: "127.0.0.1",
        databaseUrl: failureDatabaseUrl,
        poolMax: 2,
        authBaseURL: environments[winnerIndex].OCC_AUTH_BASE_URL,
        authSecret: environments[winnerIndex].OCC_AUTH_SECRET,
        logging: { level: "warn" },
      },
      {
        installation: driverConfiguration,
        computeDriver: passiveComputeDriver(),
        configurationDriver: createTestConfigurationDriver(),
        secretDriver: createTestSecretDriver({ id: driverConfiguration.drivers.secret.id }),
        createIAMDriver(state) {
          return new NativeIAMDriver(state, { id: driverConfiguration.drivers.iam.id });
        },
      },
    );
    apps.push(reloaded);
    assert.equal(
      sha256(await readFile(environments[winnerIndex].OCC_BOOTSTRAP_SERVICE_KEY_FILE, "utf8")),
      winnerOutputDigest,
    );
    const installation = await reloaded.inject({
      method: "GET",
      url: "/installation",
      headers: { "x-api-key": winnerOutput.data.key, host: "127.0.0.1" },
    });
    assert.equal(installation.statusCode, 200, installation.body);
    assert.equal(installation.json().data.id, winnerOutput.meta.installationId);
    const apiKey = winnerOutput.data.key;
    const namespace = await request(reloaded, "POST", "/namespaces", apiKey, {
      name: "Logging admission",
    });
    assert.equal(namespace.status, 201, JSON.stringify(namespace.body));
    await markNamespaceReady(namespace.body.data.id);
    const configuration = await request(
      reloaded,
      "POST",
      `/namespaces/${namespace.body.data.id}/configurations`,
      apiKey,
      { kind: "agent", values: createHarnessConfiguration("openclaw", "gpt-4.1") },
    );
    assert.equal(configuration.status, 201, JSON.stringify(configuration.body));
    const secret = await request(
      reloaded,
      "POST",
      `/namespaces/${namespace.body.data.id}/secrets`,
      apiKey,
      {
        name: "bootstrap-logging-model-key",
        value: "synthetic-bootstrap-logging-model-key",
      },
    );
    assert.equal(secret.status, 201, JSON.stringify(secret.body));
    const agent = await request(
      reloaded,
      "POST",
      `/namespaces/${namespace.body.data.id}/agents`,
      apiKey,
      {
        name: "Logging Agent",
        configurationId: configuration.body.data.id,
        harnessAuth: { method: "api_key", source: secret.body.data.ref },
      },
    );
    assert.equal(agent.status, 201, JSON.stringify(agent.body));
    await withPool(failureDatabaseUrl, async (pool) => {
      const roleId = `role-${randomUUID()}`;
      await pool.query(
        `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
         VALUES ($1, $2, 'Bootstrap logging model delivery', $3::jsonb)`,
        [
          roleId,
          namespace.body.data.id,
          JSON.stringify([{ action: "operate", resourceKind: "secret" }]),
        ],
      );
      await pool.query(
        `INSERT INTO occ.iam_access_bindings
          (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id)
         SELECT $1, namespace_id, service_principal_id, $4, 'secret', $5
         FROM occ.agents WHERE namespace_id = $2 AND id = $3`,
        [
          `binding-${randomUUID()}`,
          namespace.body.data.id,
          agent.body.data.id,
          roleId,
          secret.body.data.id,
        ],
      );
    });
    const revision = await request(
      reloaded,
      "POST",
      `/namespaces/${namespace.body.data.id}/agents/${agent.body.data.id}/deploy`,
      apiKey,
    );
    assert.equal(revision.status, 202, JSON.stringify(revision.body));
    assert.equal(admittedLoggingLevel(revision.body.data.configuration), "warn");
    if (loserCreatedServiceKey) {
      const loserOutput = JSON.parse(
        await readFile(environments[loserIndex].OCC_BOOTSTRAP_SERVICE_KEY_FILE, "utf8"),
      );
      assert.match(loserOutput.meta.installationId, /^ins_/);
      assert.match(loserOutput.data.servicePrincipalId, /^spn_/);
      const rejectedInstallation = await reloaded.inject({
        method: "GET",
        url: "/installation",
        headers: { "x-api-key": loserOutput.data.key, host: "127.0.0.1" },
      });
      assert.ok([401, 403].includes(rejectedInstallation.statusCode), rejectedInstallation.body);
    }
  },
);

test(
  "production bootstrap preserves committed credentials when COMMIT acknowledgement is lost",
  requiresFailurePostgres,
  async (context) => {
    await resetFailureDatabase();
    const directory = await privateOutputDirectory("openclaw-bootstrap-unknown-production-");
    context.after(async () => {
      await resetFailureDatabase();
      await rm(directory, { recursive: true, force: true });
    });

    const environment = productionEnvironment({
      directory,
      email: `bootstrap-unknown-${randomUUID()}@example.test`,
      name: "Bootstrap unknown production",
    });
    environment.NODE_OPTIONS = [
      process.env.NODE_OPTIONS,
      `--import=${commitAcknowledgementFaultFixture}`,
    ]
      .filter(Boolean)
      .join(" ");
    environment.OCC_TEST_POSTGRES_COMMIT_ACK_FAULT = "installation-bootstrap";
    const result = await runProductionBootstrap(environment);
    assert.equal(result.ok, false);
    const failure = jsonLines(result.stderr).find(
      (line) => line.event === "installation.bootstrap-failed",
    );
    assert.ok(failure, result.stderr);
    assert.equal(failure.code, "COMMIT_OUTCOME_UNKNOWN");
    assert.equal(failure.attempt.passwordFile, environment.OCC_BOOTSTRAP_PASSWORD_FILE);
    assert.equal(failure.attempt.serviceKeyFile, environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE);

    assert.equal(await exists(environment.OCC_BOOTSTRAP_PASSWORD_FILE), true);
    assert.equal(await exists(environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE), true);
    const serviceKeyOutput = JSON.parse(
      await readFile(environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE, "utf8"),
    );
    assert.equal(serviceKeyOutput.meta.installationId, failure.attempt.installationId);
    assert.equal(serviceKeyOutput.data.id, failure.attempt.serviceKeyId);

    const counts = await rowCounts();
    assert.deepEqual(counts, {
      installations: 1,
      bootstrap_audits: 1,
      principals: 1,
      service_principals: 1,
      bindings: 2,
      service_keys: 1,
      users: 1,
      namespaces: 1,
      namespace_work: 1,
    });
  },
);

test(
  "known bootstrap failures preserve created artifacts and report safe diagnostics",
  requiresFailurePostgres,
  async (context) => {
    await resetFailureDatabase();
    await installKnownInstallationFailure();
    const directory = await privateOutputDirectory("openclaw-bootstrap-known-failure-");
    context.after(async () => {
      await resetFailureDatabase();
      await rm(directory, { recursive: true, force: true });
    });

    const environment = productionEnvironment({
      directory,
      email: `bootstrap-cleanup-${randomUUID()}@example.test`,
      name: "Bootstrap cleanup diagnostics",
    });
    const result = await runProductionBootstrap(environment);
    assert.equal(result.ok, false);
    const failure = jsonLines(result.stderr).find(
      (line) => line.event === "installation.bootstrap-failed",
    );
    assert.ok(failure, result.stderr);
    assert.equal(failure.code, "BOOTSTRAP_FAILED");
    assert.equal("cleanupFailures" in failure, false);
    assert.doesNotMatch(result.stderr, /^occ_/m);
    assert.equal(failure.attempt.passwordFile, environment.OCC_BOOTSTRAP_PASSWORD_FILE);
    assert.equal(failure.attempt.serviceKeyFile, environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE);
    assert.equal(await exists(environment.OCC_BOOTSTRAP_PASSWORD_FILE), true);
    assert.equal(await exists(environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE), true);
    const serviceKeyOutput = JSON.parse(
      await readFile(environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE, "utf8"),
    );
    assert.equal(serviceKeyOutput.meta.installationId, failure.attempt.installationId);
    assert.equal(serviceKeyOutput.data.id, failure.attempt.serviceKeyId);

    const counts = await rowCounts();
    assert.deepEqual(counts, {
      installations: 0,
      bootstrap_audits: 0,
      principals: 0,
      service_principals: 0,
      bindings: 0,
      service_keys: 1,
      users: 1,
      namespaces: 0,
      namespace_work: 0,
    });
  },
);

test(
  "development bootstrap preserves credentials when COMMIT acknowledgement is lost",
  requiresFailurePostgres,
  async (context) => {
    await resetFailureDatabase();
    const directory = await privateOutputDirectory("openclaw-bootstrap-unknown-development-");
    context.after(async () => {
      await resetFailureDatabase();
      await rm(directory, { recursive: true, force: true });
    });

    const environment = developmentEnvironment({
      directory,
      email: `bootstrap-development-${randomUUID()}@openclaw.local`,
      name: "Bootstrap unknown development",
    });
    environment.NODE_OPTIONS = [
      process.env.NODE_OPTIONS,
      `--import=${commitAcknowledgementFaultFixture}`,
    ]
      .filter(Boolean)
      .join(" ");
    environment.OCC_TEST_POSTGRES_COMMIT_ACK_FAULT = "installation-bootstrap";
    const result = await runBootstrapInstallation(environment);
    assert.equal(result.ok, false);
    const failure = jsonLines(result.stderr).find(
      (line) => line.event === "installation.bootstrap-failed",
    );
    assert.ok(failure, result.stderr);
    assert.equal(failure.code, "COMMIT_OUTCOME_UNKNOWN");
    assert.equal(failure.attempt.serviceKeyFile, environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE);

    assert.equal(await exists(environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE), true);
    const serviceKeyOutput = JSON.parse(
      await readFile(environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE, "utf8"),
    );
    const counts = await rowCounts();
    assert.deepEqual(counts, {
      installations: 1,
      bootstrap_audits: 1,
      principals: 1,
      service_principals: 1,
      bindings: 2,
      service_keys: 1,
      users: 1,
      namespaces: 1,
      namespace_work: 1,
    });
    assert.match(serviceKeyOutput.data.key, /^occ_/);
    assert.equal(serviceKeyOutput.data.name, "bootstrap-admin");
  },
);
