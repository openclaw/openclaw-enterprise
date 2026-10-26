import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { composePostgresDevelopment } from "../helpers/password-hasher.mjs";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { injectJson } from "../helpers/inject-json.mjs";
import { jsonEvent, jsonLines } from "../helpers/json-lines.mjs";
import { withPool } from "../helpers/postgres-database.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { admittedLoggingLevel } from "../../packages/contracts/src/index.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import {
  bootstrapInstallationInProcess,
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

async function privateOutputDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await chmod(directory, 0o700);
  return directory;
}

async function prepareBootstrapFailureFixture(context, label) {
  await resetFailureDatabase();
  const directory = await privateOutputDirectory(`openclaw-bootstrap-${label}-`);
  context.after(async () => {
    const errors = [];
    try {
      await resetFailureDatabase();
    } catch (error) {
      errors.push(error);
    }
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Failed to clean up bootstrap test resources");
    }
  });
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

// Most cases run the Job's code in this process (bootstrapInstallationInProcess, the function
// scripts/bootstrap-installation.mjs runs), which saves a Node start per run. These run the
// real script, for its exit status and its output streams: the lost COMMIT acknowledgement
// (its fault loads with --import), the retained-output refusal, the known failure, the fresh
// full path and the fast path.
async function runBootstrap(environment) {
  return bootstrapInstallationInProcess(environment);
}

async function runBootstrapScript(environment) {
  return runBootstrapInstallation(environment);
}

async function bootstrapWithLostCommitAcknowledgement(environment) {
  const result = await runBootstrapInstallation({
    ...environment,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${commitAcknowledgementFaultFixture}`]
      .filter(Boolean)
      .join(" "),
    OCC_TEST_POSTGRES_COMMIT_ACK_FAULT: "installation-bootstrap",
  });
  assert.equal(result.ok, false);
  const failure = jsonEvent(result.stderr, "installation.bootstrap-failed");
  assert.equal(failure.code, "COMMIT_OUTCOME_UNKNOWN");
  assert.equal(failure.attempt.serviceKeyFile, environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE);
  assert.equal(existsSync(environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE), true);
  const serviceKeyOutput = JSON.parse(
    await readFile(environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE, "utf8"),
  );
  // The logged attempt keeps the IDs the run assigned, each in its OCC format (finding 2246).
  assert.match(failure.attempt.installationId, /^ins_[0-9a-f-]{36}$/);
  assert.match(failure.attempt.principalId, /^prn_[0-9a-f-]{36}$/);
  assert.match(failure.attempt.servicePrincipalId, /^spn_[0-9a-f-]{36}$/);
  assert.equal(failure.attempt.servicePrincipalId, serviceKeyOutput.data.servicePrincipalId);
  assert.deepEqual(await rowCounts(), {
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
  return { failure, serviceKeyOutput };
}

async function request(app, method, url, apiKey, body) {
  const response = await injectJson(app, method, url, { key: apiKey, body });
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

function assertBootstrapRaceOutcome(results, sharedOutput = false) {
  const successful = results.filter((result) => result.ok === true);
  const failed = results.filter((result) => result.ok === false);
  assert.equal(successful.length, 1, "expected one successful bootstrap");
  assert.equal(failed.length, 1, "expected one failed bootstrap");
  const bootstrapped = jsonLines(successful[0].stdout).filter(
    (line) => line.event === "installation.bootstrapped",
  );
  assert.equal(bootstrapped.length, 1, "expected one installation.bootstrapped event");
  const failure = jsonLines(failed[0].stderr).find(
    (line) => line.event === "installation.bootstrap-failed",
  );
  assert.ok(failure, "expected an installation.bootstrap-failed event");
  if (sharedOutput && failure.code === "BOOTSTRAP_OUTPUT_EXISTS") {
    // The winner wrote an output before the other run finished checking both destinations.
    assert.equal(failure.attempt, undefined);
  } else {
    assert.ok(failure.attempt, "expected a failed bootstrap attempt");
  }
  return { winnerIndex: results.indexOf(successful[0]), winnerEvent: bootstrapped[0] };
}

function assertSingleDurableBootstrapSeed(counts) {
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
}

for (const sharedOutput of [false, true]) {
  test(
    `concurrent production bootstraps ${sharedOutput ? "with shared output paths" : "with separate output paths"} commit at most one seed`,
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

      const results = await Promise.all(environments.map((env) => runBootstrap(env)));
      const { winnerEvent: winner } = assertBootstrapRaceOutcome(results, sharedOutput);
      const counts = await rowCounts();
      assertSingleDurableBootstrapSeed(counts);
      const winnerIndex = environments.findIndex(
        (environment) => environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE === winner.serviceKeyFile,
      );
      assert.notEqual(winnerIndex, -1);
      const loserIndex = winnerIndex === 0 ? 1 : 0;
      const loserCreatedServiceKey =
        !sharedOutput && existsSync(environments[loserIndex].OCC_BOOTSTRAP_SERVICE_KEY_FILE);
      if (sharedOutput) {
        assert.ok([1, 2].includes(counts.service_keys));
        assert.ok([1, 2].includes(counts.users));
      } else {
        assert.equal(counts.service_keys, loserCreatedServiceKey ? 2 : 1);
        assert.equal(counts.users, loserCreatedServiceKey ? 2 : 1);
      }
      const outputEnvironment = sharedOutput ? environments[0] : environments[winnerIndex];
      assert.equal(existsSync(outputEnvironment.OCC_BOOTSTRAP_PASSWORD_FILE), true);
      assert.equal(existsSync(outputEnvironment.OCC_BOOTSTRAP_SERVICE_KEY_FILE), true);
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
        assert.equal(existsSync(environment.OCC_BOOTSTRAP_PASSWORD_FILE), loserCreatedServiceKey);
        assert.equal(
          existsSync(environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE),
          loserCreatedServiceKey,
        );
      }
    },
  );
}

test(
  "concurrent development bootstraps reject the loser and reload the committed winner",
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
    const results = await Promise.all(environments.map((env) => runBootstrap(env)));
    const { winnerIndex } = assertBootstrapRaceOutcome(results);
    const loserIndex = winnerIndex === 0 ? 1 : 0;
    const winnerOutputBytes = await readFile(
      environments[winnerIndex].OCC_BOOTSTRAP_SERVICE_KEY_FILE,
      "utf8",
    );
    const winnerOutputDigest = sha256(winnerOutputBytes);
    const winnerOutput = JSON.parse(winnerOutputBytes);
    const loserCreatedServiceKey = existsSync(
      environments[loserIndex].OCC_BOOTSTRAP_SERVICE_KEY_FILE,
    );

    const counts = await rowCounts();
    assertSingleDurableBootstrapSeed(counts);
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
    const directory = await prepareBootstrapFailureFixture(context, "unknown-production");

    const environment = productionEnvironment({
      directory,
      email: `bootstrap-unknown-${randomUUID()}@example.test`,
      name: "Bootstrap unknown production",
    });
    const { failure, serviceKeyOutput } = await bootstrapWithLostCommitAcknowledgement(environment);
    assert.equal(failure.attempt.passwordFile, environment.OCC_BOOTSTRAP_PASSWORD_FILE);
    assert.equal(existsSync(environment.OCC_BOOTSTRAP_PASSWORD_FILE), true);
    assert.equal(serviceKeyOutput.meta.installationId, failure.attempt.installationId);
    assert.equal(serviceKeyOutput.data.id, failure.attempt.serviceKeyId);
  },
);

test(
  "fresh production bootstrap refuses either retained credential output before creating credentials",
  requiresFailurePostgres,
  async (context) => {
    const directory = await prepareBootstrapFailureFixture(context, "retained-output");
    for (const retainPassword of [true, false]) {
      // Separate directories let the fixture clean up both cases without unlinking the marker here.
      const env = productionEnvironment({
        directory: await mkdtemp(join(directory, "attempt-")),
        email: "retained-output@example.test",
        name: "Bootstrap retained output",
      });
      const password = env.OCC_BOOTSTRAP_PASSWORD_FILE;
      const serviceKey = env.OCC_BOOTSTRAP_SERVICE_KEY_FILE;
      const [retained, absent] = retainPassword ? [password, serviceKey] : [serviceKey, password];
      const marker = "retained-credential-sentinel";
      const file = await open(retained, "wx+", 0o600);
      try {
        await file.writeFile(marker);
        const before = await file.stat({ bigint: true });

        const result = await runBootstrapScript(env);
        assert.equal(result.ok, false);
        const failure = jsonLines(result.stderr).find(
          (line) => line.event === "installation.bootstrap-failed",
        );
        assert.equal(failure?.code, "BOOTSTRAP_OUTPUT_EXISTS", result.stderr);
        assert.equal(failure.attempt, undefined);
        assert.match(result.stderr, /preserve it and reconcile the original installation/i);
        for (const privateValue of [directory, marker]) {
          assert.ok(
            !(result.stdout + result.stderr).includes(privateValue),
            "diagnostic disclosed a path or content",
          );
        }

        const after = await lstat(retained, { bigint: true });
        for (const field of ["dev", "ino", "mode", "size", "ctimeNs", "mtimeNs"]) {
          assert.equal(after[field], before[field]);
        }
        // Check the bytes on the original file, never reopen the path we just inspected.
        const buffer = Buffer.alloc(Buffer.byteLength(marker) + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        assert.equal(buffer.subarray(0, bytesRead).toString("utf8"), marker);
        await assert.rejects(lstat(absent), { code: "ENOENT" });
        const counts = await rowCounts();
        for (const [table, count] of Object.entries(counts)) {
          assert.equal(count, 0, table);
        }
      } finally {
        await file.close();
      }
    }
  },
);

for (const variable of ["OCC_BOOTSTRAP_PASSWORD_FILE", "OCC_BOOTSTRAP_SERVICE_KEY_FILE"]) {
  test(
    `fresh production bootstrap rejects a trailing separator in ${variable} before creating credentials`,
    requiresFailurePostgres,
    async (context) => {
      const directory = await prepareBootstrapFailureFixture(context, "trailing-separator");
      const env = productionEnvironment({
        directory,
        email: "trailing-separator@example.test",
        name: "Bootstrap trailing separator",
      });
      // lstat can report ENOENT for this path, but an exclusive file create cannot use it.
      env[variable] += sep;
      const result = await runBootstrap(env);
      assert.equal(result.ok, false);
      const failure = jsonLines(result.stderr).find(
        (line) => line.event === "installation.bootstrap-failed",
      );
      assert.equal(failure?.code, "BOOTSTRAP_FAILED");
      assert.equal("attempt" in failure, false);
      assert.equal((result.stdout + result.stderr).includes(directory), false, "path disclosed");
      assert.deepEqual(await readdir(directory), []);
      for (const [table, count] of Object.entries(await rowCounts())) {
        assert.equal(count, 0, table);
      }
    },
  );
}

test(
  "known bootstrap failures preserve created artifacts and report safe diagnostics",
  requiresFailurePostgres,
  async (context) => {
    const directory = await prepareBootstrapFailureFixture(context, "known-failure");
    await installKnownInstallationFailure();

    const environment = productionEnvironment({
      directory,
      email: `bootstrap-cleanup-${randomUUID()}@example.test`,
      name: "Bootstrap cleanup diagnostics",
    });
    const result = await runBootstrapScript(environment);
    assert.equal(result.ok, false);
    const failure = jsonEvent(result.stderr, "installation.bootstrap-failed");
    assert.equal(failure.code, "BOOTSTRAP_FAILED");
    assert.equal("cleanupFailures" in failure, false);
    assert.doesNotMatch(result.stderr, /^occ_/m);
    assert.equal(failure.attempt.passwordFile, environment.OCC_BOOTSTRAP_PASSWORD_FILE);
    assert.equal(failure.attempt.serviceKeyFile, environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE);
    assert.equal(existsSync(environment.OCC_BOOTSTRAP_PASSWORD_FILE), true);
    assert.equal(existsSync(environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE), true);
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
  "production and development bootstrap refuse an Installation name outside the Name rule before creating anything",
  requiresFailurePostgres,
  async (context) => {
    const directory = await prepareBootstrapFailureFixture(context, "installation-name");

    // PostgreSQL's name check accepts a trailing NBSP and a line separator; the API's Name
    // rule refuses both. Development bootstrap reads its name from OPENCLAW_DEV_INSTALLATION_NAME.
    for (const environment of [
      productionEnvironment({
        directory,
        email: `bootstrap-installation-name-${randomUUID()}@example.test`,
        name: "Installation\u00a0",
      }),
      developmentEnvironment({
        directory,
        email: `bootstrap-installation-name-${randomUUID()}@example.test`,
        name: "Installation\u2028name",
      }),
    ]) {
      const label = environment.NODE_ENV;
      const result = await runBootstrap(environment);
      assert.equal(result.ok, false, label);
      const failure = jsonLines(result.stderr).find(
        (line) => line.event === "installation.bootstrap-failed",
      );
      assert.equal(failure?.code, "INSTALLATION_NAME_INVALID", `${label}: ${result.stderr}`);
      if (environment.OCC_BOOTSTRAP_PASSWORD_FILE !== undefined) {
        assert.equal(existsSync(environment.OCC_BOOTSTRAP_PASSWORD_FILE), false, label);
      }
      assert.equal(existsSync(environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE), false, label);
      assert.deepEqual(
        await rowCounts(),
        {
          installations: 0,
          bootstrap_audits: 0,
          principals: 0,
          service_principals: 0,
          bindings: 0,
          service_keys: 0,
          users: 0,
          namespaces: 0,
          namespace_work: 0,
        },
        label,
      );
    }
  },
);

test(
  "API and worker startup refuse a stored Installation name outside the Name rule",
  requiresFailurePostgres,
  async (context) => {
    const { environment } = await bootstrapExistingInstallation(context, "stored-name");
    const configurationRoot = await temporaryDirectory(context, "openclaw-bootstrap-stored-name-");
    // An Installation stored before OCC applied the Name rule can hold a trailing NBSP:
    // PostgreSQL's name check accepts it.
    await withPool(migratorDatabaseUrl(), (pool) =>
      pool.query("UPDATE occ.installation SET name = $1", ["Installation\u00a0"]),
    );
    const started = spawnSync(process.execPath, ["apps/controller/src/server.mjs"], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: {
        ...process.env,
        NODE_ENV: "development",
        OCC_HOST: "127.0.0.1",
        OCC_PORT: "39999",
        OCC_DATABASE_URL: failureDatabaseUrl,
        OCC_AUTH_BASE_URL: environment.OCC_AUTH_BASE_URL,
        OCC_AUTH_SECRET: environment.OCC_AUTH_SECRET,
        // Development composition builds these Drivers before it reads the Installation.
        OCC_DOCKER_RUNTIME_IMAGE: "openclaw-enterprise-runtime:not-used-by-this-test",
        OCC_DEVELOPMENT_CONFIGURATION_ROOT: configurationRoot,
      },
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.equal(started.status, 1, started.stderr);
    const failure = jsonLines(started.stderr).find((line) => line.event === "startup-error");
    assert.equal(failure?.code, "INSTALLATION_NAME_INVALID", started.stderr);

    // The development worker entrypoint needs a Docker runtime image before it reads the
    // Installation, so start the worker itself with passive Drivers.
    const driverConfiguration = { ...createInstallationDriverConfiguration(), backend: [] };
    const pool = new pg.Pool({ connectionString: failureDatabaseUrl, max: 2 });
    const worker = createControllerWorker({
      pool,
      mode: "production",
      drivers: {
        installation: driverConfiguration,
        computeDriver: passiveComputeDriver(),
        configurationDriver: createTestConfigurationDriver(),
        secretDriver: createTestSecretDriver({ id: driverConfiguration.drivers.secret.id }),
        createIAMDriver(state) {
          return new NativeIAMDriver(state, { id: driverConfiguration.drivers.iam.id });
        },
      },
      emit: () => {},
    });
    try {
      await assert.rejects(
        worker.start(),
        /The stored Installation name breaks the Name rule: 1 to 200 characters/,
      );
    } finally {
      await worker.stop().catch(() => {});
      await pool.end().catch(() => {});
    }

    // The production worker entrypoint builds its configured Drivers without contacting them,
    // so it reaches the stored Installation and names the code.
    const configPath = join(configurationRoot, "installation.yaml");
    await writeFile(configPath, JSON.stringify(createInstallationDriverConfiguration()), "utf8");
    const workerProcess = spawnSync(process.execPath, ["apps/controller/src/worker.mjs"], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "production",
        OCC_CONFIG_PATH: configPath,
        OCC_DATABASE_URL: failureDatabaseUrl,
      },
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.equal(workerProcess.status, 1, `${workerProcess.error ?? ""}\n${workerProcess.stderr}`);
    const workerFailure = jsonLines(workerProcess.stderr).find(
      (line) => line.event === "worker.startup-error",
    );
    assert.equal(workerFailure?.code, "INSTALLATION_NAME_INVALID", workerProcess.stderr);
  },
);

test(
  "development bootstrap preserves credentials when COMMIT acknowledgement is lost",
  requiresFailurePostgres,
  async (context) => {
    const directory = await prepareBootstrapFailureFixture(context, "unknown-development");

    const environment = developmentEnvironment({
      directory,
      email: `bootstrap-development-${randomUUID()}@openclaw.local`,
      name: "Bootstrap unknown development",
    });
    const { serviceKeyOutput } = await bootstrapWithLostCommitAcknowledgement(environment);
    assert.match(serviceKeyOutput.data.key, /^occ_/);
    assert.equal(serviceKeyOutput.data.name, "bootstrap-admin");
  },
);

const ADMINISTRATOR_PRINCIPAL = "(SELECT id FROM occ.iam_identities WHERE kind = 'principal')";

// Each case breaks one invariant the existing-Installation check verifies. The fast
// check must not accept any of them; the full check then fails exactly as before.
const PARTIAL_INSTALLATIONS = [
  ["administrator account", `UPDATE occ."user" SET email = 'moved-' || email`],
  [
    "Principal subject",
    "UPDATE occ.iam_identities SET subject = 'another-user' WHERE kind = 'principal'",
  ],
  [
    "Principal issuer",
    "UPDATE occ.iam_identities SET issuer = issuer || ':moved' WHERE kind = 'principal'",
  ],
  [
    "administrator binding",
    `DELETE FROM occ.iam_access_bindings WHERE identity_subject_id = ${ADMINISTRATOR_PRINCIPAL}`,
  ],
  ...["administer", "read"].map((action) => [
    `${action} installation permission`,
    `UPDATE occ.iam_roles AS role SET permissions = (
       SELECT jsonb_agg(permission) FROM jsonb_array_elements(role.permissions) AS permission
       WHERE NOT (permission->>'action' = '${action}' AND permission->>'resourceKind' = 'installation'))
     WHERE id IN (SELECT role_id FROM occ.iam_access_bindings
       WHERE identity_subject_id = ${ADMINISTRATOR_PRINCIPAL})`,
  ]),
  [
    "readable IAM state",
    `UPDATE occ.iam_access_bindings SET resource_kind = 'unknown-kind', resource_id = 'x'
     WHERE identity_subject_id = ${ADMINISTRATOR_PRINCIPAL}`,
  ],
];

async function bootstrapExistingInstallation(context, label, run = runBootstrap) {
  const directory = await prepareBootstrapFailureFixture(context, label);
  const environment = productionEnvironment({
    directory,
    email: `bootstrap-${label}-${randomUUID()}@example.test`,
    name: `Bootstrap ${label}`,
  });
  const fresh = await run(environment);
  assert.equal(fresh.ok, true, fresh.stderr);
  return { environment, fresh };
}

function alreadyBootstrappedEvent(result) {
  return jsonLines(result.stderr).find(
    (line) => line.event === "installation.already-bootstrapped",
  );
}

test(
  "production bootstrap of a fresh database takes the full path",
  requiresFailurePostgres,
  async (context) => {
    const { fresh } = await bootstrapExistingInstallation(
      context,
      "fresh-path",
      runBootstrapScript,
    );
    const result = jsonEvent(fresh.stdout, "installation.bootstrapped");
    // The log line names the new Installation too (finding 2245).
    const logged = jsonLines(fresh.stderr).find(
      (line) => line.event === "installation.bootstrapped",
    );
    assert.match(result.installationId, /^ins_[0-9a-f-]{36}$/);
    assert.equal(logged?.installationId, result.installationId, fresh.stderr);
    assert.equal(alreadyBootstrappedEvent(fresh), undefined);
  },
);

test(
  "production bootstrap of a complete Installation verifies it without the auth stack",
  requiresFailurePostgres,
  async (context) => {
    const { environment, fresh } = await bootstrapExistingInstallation(context, "fast-path");
    const counts = await rowCounts();
    const outputs = await Promise.all(
      [environment.OCC_BOOTSTRAP_PASSWORD_FILE, environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE].map(
        async (path) => sha256(await readFile(path, "utf8")),
      ),
    );

    const repeated = await runBootstrapScript(environment);
    assert.equal(repeated.ok, true, repeated.stderr);
    assert.ok(
      jsonLines(repeated.stdout).some((line) => line.event === "installation.already-bootstrapped"),
      repeated.stdout,
    );
    assert.equal(alreadyBootstrappedEvent(repeated)?.step, "fast-path", repeated.stderr);
    assert.equal(
      alreadyBootstrappedEvent(repeated)?.installationId,
      jsonLines(fresh.stdout).find((line) => line.event === "installation.bootstrapped")
        ?.installationId,
      repeated.stderr,
    );
    assert.deepEqual(await rowCounts(), counts);
    assert.deepEqual(
      await Promise.all(
        [environment.OCC_BOOTSTRAP_PASSWORD_FILE, environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE].map(
          async (path) => sha256(await readFile(path, "utf8")),
        ),
      ),
      outputs,
    );
  },
);

test(
  "production bootstrap takes the fast path whatever the administrator's sign-in accounts",
  requiresFailurePostgres,
  async (context) => {
    // Both checks look up the user only; its credential accounts do not count.
    const { environment } = await bootstrapExistingInstallation(context, "no-accounts");
    await withPool(migratorDatabaseUrl(), (pool) => pool.query("DELETE FROM occ.account"));
    const repeated = await runBootstrap(environment);
    assert.equal(repeated.ok, true, repeated.stderr);
    assert.equal(alreadyBootstrappedEvent(repeated)?.step, "fast-path", repeated.stderr);
  },
);

test(
  "production bootstrap of a complete Installation still rejects a non-origin auth base URL",
  requiresFailurePostgres,
  async (context) => {
    const { environment } = await bootstrapExistingInstallation(context, "base-url");
    const repeated = await runBootstrap({
      ...environment,
      OCC_AUTH_BASE_URL: "http://127.0.0.1:0/auth",
    });
    assert.equal(repeated.ok, false, repeated.stdout);
    assert.equal(alreadyBootstrappedEvent(repeated), undefined, repeated.stderr);
    const failure = jsonLines(repeated.stderr).find(
      (line) => line.event === "installation.bootstrap-failed",
    );
    assert.equal(failure?.code, "AUTH_BASE_URL_INVALID", repeated.stderr);
  },
);

for (const [invariant, breakInvariant] of PARTIAL_INSTALLATIONS) {
  test(
    `production bootstrap without the ${invariant} takes the full path and fails`,
    requiresFailurePostgres,
    async (context) => {
      const { environment } = await bootstrapExistingInstallation(
        context,
        `partial-${invariant.toLowerCase().replaceAll(/[^a-z]+/g, "-")}`,
      );
      await withPool(migratorDatabaseUrl(), (pool) => pool.query(breakInvariant));
      const counts = await rowCounts();

      const repeated = await runBootstrap(environment);
      assert.equal(repeated.ok, false, repeated.stdout);
      assert.equal(alreadyBootstrappedEvent(repeated), undefined, repeated.stderr);
      const failure = jsonLines(repeated.stderr).find(
        (line) => line.event === "installation.bootstrap-failed",
      );
      assert.equal(failure?.code, "BOOTSTRAP_FAILED", repeated.stderr);
      assert.equal(failure.attempt, undefined);
      // The existing-Installation path never repairs.
      assert.deepEqual(await rowCounts(), counts);
    },
  );
}
