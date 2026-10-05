import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { FilesystemConfigurationDriver } from "../../apps/controller/src/drivers/configuration/filesystem/index.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { setTimeout as delay } from "node:timers/promises";
import { composeProduction } from "../../apps/controller/src/composition/production.ts";
import { composePostgresDevelopment } from "../../apps/controller/src/composition/development-postgres.ts";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { createOccLogger } from "../../apps/controller/src/logging.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { authenticatedHeaders, signInWithEmailPassword } from "../helpers/auth-session.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { normalizePresetTemplate } from "../../packages/contracts/src/index.ts";
import { BOOTSTRAP_DEFAULT_NAMESPACE_NAME } from "../../packages/occ/src/index.ts";

const databaseUrl = process.env.OCC_PRODUCTION_WIREUP_DATABASE_URL;
const repository = fileURLToPath(new URL("../../", import.meta.url));
const run = promisify(execFile);
const requireControllerDependency = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const adminEmail = "admin@example.test";
const authSecret = "production-wireup-auth-secret-at-least-32-bytes";
const authBaseURL = "http://127.0.0.1:0";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function defaultNamespaceRows(pool) {
  return (
    await pool.query(
      `SELECT namespace.id, namespace.name, namespace.status, work.idempotency_key
       FROM occ.namespaces AS namespace
       JOIN occ.controller_work AS work ON work.namespace_id = namespace.id
       WHERE namespace.name = $1`,
      [BOOTSTRAP_DEFAULT_NAMESPACE_NAME],
    )
  ).rows;
}

function createPassiveComputeDriver() {
  return {
    id: "compute-production-wireup",
    capability: "compute",
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
    async ensureNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceReady: true };
    },
    async deleteNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceDeleted: true };
    },
    async prepareRevision(revision) {
      return {
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
        ready: true,
      };
    },
    async retireRevision() {},
  };
}

function memoryLog() {
  const lines = [];
  return {
    lines,
    logger: createOccLogger({
      component: "occ-api-production-wireup",
      destination: {
        write(chunk) {
          for (const line of String(chunk).split("\n")) {
            if (line.length > 0) {
              lines.push(JSON.parse(line));
            }
          }
          return true;
        },
      },
    }),
  };
}

function parseLogEvents(stderr) {
  return stderr
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

async function productionDrivers({ includeDefaults = false, files, configurationRoot } = {}) {
  const configuration = createInstallationDriverConfiguration();
  configuration.presets = { includeDefaults, ...(files === undefined ? {} : { files }) };
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
    defaultPresets: runtime.defaultPresets,
    shadowedDefaultPresets: runtime.shadowedDefaultPresets,
    bundledPresetVersions: runtime.bundledPresetVersions,
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
    const environment = {
      ...process.env,
      NODE_ENV: "production",
      OCC_DATABASE_URL: databaseUrl,
      OCC_AUTH_SECRET: authSecret,
      OCC_AUTH_BASE_URL: authBaseURL,
      OCC_BOOTSTRAP_ADMIN_EMAIL: adminEmail,
      OCC_BOOTSTRAP_PASSWORD_FILE: join(
        await mkdtemp(join(tmpdir(), "openclaw-enterprise-bootstrap-password-")),
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
    let app;
    let endpoint;
    let pool;
    try {
      // Run the actual production Job; the generated credential is handed off only via the
      // protected operator-selected file.
      const bootstrapped = await run(process.execPath, ["scripts/bootstrap-installation.mjs"], {
        cwd: repository,
        env: environment,
      });
      assert.match(bootstrapped.stdout, /installation\.bootstrapped/);

      const pg = requireControllerDependency("pg");
      pool = new pg.Pool({ connectionString: databaseUrl });
      // Creating an administrator is not signing in: no usable session may exist yet.
      const bootstrapSessions = await pool.query(
        "SELECT count(*)::integer AS count FROM occ.session",
      );
      assert.equal(bootstrapSessions.rows[0].count, 0);
      const defaultNamespace = await defaultNamespaceRows(pool);
      assert.equal(defaultNamespace.length, 1);
      assert.match(defaultNamespace[0].id, /^ns_/);
      assert.equal(defaultNamespace[0].name, BOOTSTRAP_DEFAULT_NAMESPACE_NAME);
      assert.equal(defaultNamespace[0].status, "provisioning");
      assert.equal(
        defaultNamespace[0].idempotency_key,
        `namespace:${defaultNamespace[0].id}:reconcile:ready`,
      );

      const passwordStat = await stat(environment.OCC_BOOTSTRAP_PASSWORD_FILE);
      assert.equal(passwordStat.mode & 0o777, 0o600);
      const password = (await readFile(environment.OCC_BOOTSTRAP_PASSWORD_FILE, "utf8")).trim();
      const passwordDigest = sha256(password);
      assert.match(password, /^[A-Za-z0-9_-]{43}$/);
      assert.notEqual(password, adminEmail);
      assert.notEqual(password, authSecret);
      const serviceKeyStat = await stat(environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE);
      assert.equal(serviceKeyStat.mode & 0o777, 0o600);
      const serviceKeyBytes = await readFile(environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE, "utf8");
      const serviceKeyDigest = sha256(serviceKeyBytes);
      const serviceKeyOutput = JSON.parse(serviceKeyBytes);
      assert.equal(serviceKeyOutput.data.name, "bootstrap-admin");
      assert.match(serviceKeyOutput.data.servicePrincipalId, /^spn_/);
      assert.match(serviceKeyOutput.data.key, /^occ_/);
      assert.equal(serviceKeyOutput.meta.installationId.startsWith("ins_"), true);
      assert.equal(
        bootstrapped.stdout.includes(password),
        false,
        "stdout must not contain password",
      );
      assert.equal(
        bootstrapped.stdout.includes(serviceKeyOutput.data.key),
        false,
        "stdout must not contain service key",
      );
      assert.equal(
        bootstrapped.stderr.includes(password),
        false,
        "stderr must not contain password",
      );
      assert.equal(
        bootstrapped.stderr.includes(serviceKeyOutput.data.key),
        false,
        "stderr must not contain service key",
      );

      // Helm upgrades and Job retries must not rotate the bootstrap credential.
      const repeated = await run(process.execPath, ["scripts/bootstrap-installation.mjs"], {
        cwd: repository,
        env: environment,
      });
      assert.match(repeated.stdout, /installation\.already-bootstrapped/);
      assert.deepEqual(await defaultNamespaceRows(pool), defaultNamespace);
      assert.equal(
        sha256((await readFile(environment.OCC_BOOTSTRAP_PASSWORD_FILE, "utf8")).trim()),
        passwordDigest,
      );
      assert.equal(
        sha256(await readFile(environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE, "utf8")),
        serviceKeyDigest,
      );
      const {
        OCC_BOOTSTRAP_INSTALLATION_NAME,
        OCC_BOOTSTRAP_PASSWORD_FILE,
        OCC_BOOTSTRAP_SERVICE_KEY_FILE,
        ...existingOnlyEnvironment
      } = environment;
      assert.equal(OCC_BOOTSTRAP_INSTALLATION_NAME.length > 0, true);
      assert.equal(OCC_BOOTSTRAP_PASSWORD_FILE.length > 0, true);
      assert.equal(OCC_BOOTSTRAP_SERVICE_KEY_FILE.length > 0, true);
      const existingOnly = await run(process.execPath, ["scripts/bootstrap-installation.mjs"], {
        cwd: repository,
        env: existingOnlyEnvironment,
      });
      assert.match(existingOnly.stdout, /installation\.already-bootstrapped/);
      assert.deepEqual(await defaultNamespaceRows(pool), defaultNamespace);
      assert.equal(
        sha256((await readFile(environment.OCC_BOOTSTRAP_PASSWORD_FILE, "utf8")).trim()),
        passwordDigest,
      );
      assert.equal(
        sha256(await readFile(environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE, "utf8")),
        serviceKeyDigest,
      );

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
        (error) => error,
      );
      assert.ok(administratorMismatch);
      const bootstrapFailure = parseLogEvents(administratorMismatch.stderr).find(
        (line) => line.event === "installation.bootstrap-failed",
      );
      assert.ok(bootstrapFailure, administratorMismatch.stderr);
      assert.deepEqual(
        {
          severity: bootstrapFailure.severity,
          service: bootstrapFailure.service,
          event: bootstrapFailure.event,
          code: bootstrapFailure.code,
        },
        {
          severity: "ERROR",
          service: "occ-bootstrap",
          event: "installation.bootstrap-failed",
          code: "BOOTSTRAP_FAILED",
        },
      );

      const rejectedAdministrator = await pool.query('SELECT id FROM occ."user" WHERE email = $1', [
        "different-admin@example.test",
      ]);
      assert.equal(rejectedAdministrator.rowCount, 0);

      // Verify persisted Better Auth ownership, the real IAM Principal, and bootstrap audit evidence.
      const installation = await pool.query(
        "SELECT id, count(*) OVER()::integer AS count FROM occ.installation",
      );
      assert.equal(installation.rows.length, 1);
      assert.equal(installation.rows[0].count, 1);
      assert.equal(serviceKeyOutput.meta.installationId, installation.rows[0].id);
      const user = await pool.query(
        `SELECT id, email, email_verified
         FROM occ."user" WHERE email = $1`,
        [adminEmail],
      );
      assert.equal(user.rows.length, 1);
      assert.equal(user.rows[0].email_verified, true);
      const account = await pool.query(
        `SELECT provider_id, account_id, password
         FROM occ.account WHERE user_id = $1`,
        [user.rows[0].id],
      );
      assert.equal(account.rows.length, 1);
      assert.equal(account.rows[0].provider_id, "credential");
      assert.equal(account.rows[0].account_id, user.rows[0].id);
      assert.equal(typeof account.rows[0].password, "string");
      assert.notEqual(account.rows[0].password, password);
      const identity = await pool.query(
        "SELECT id, kind, issuer, subject FROM occ.iam_identities WHERE subject = $1",
        [user.rows[0].id],
      );
      assert.equal(identity.rows.length, 1);
      assert.equal(identity.rows[0].kind, "principal");
      assert.match(identity.rows[0].issuer, /^occ:installation:/);
      const audit = await pool.query(
        "SELECT kind, actor_id FROM occ.audit_events WHERE kind = 'bootstrap' AND actor_id = $1",
        [identity.rows[0].id],
      );
      assert.deepEqual(audit.rows, [{ kind: "bootstrap", actor_id: identity.rows[0].id }]);
      const bootstrapServicePrincipal = await pool.query(
        `SELECT identity.id, binding.role_id
         FROM occ.iam_identities identity
         JOIN occ.iam_access_bindings binding ON binding.identity_subject_id = identity.id
         WHERE identity.id = $1
           AND identity.kind = 'service_principal'
           AND identity.namespace_id IS NULL
           AND identity.agent_id IS NULL`,
        [serviceKeyOutput.data.servicePrincipalId],
      );
      assert.equal(bootstrapServicePrincipal.rowCount, 1);
      const humanBinding = await pool.query(
        `SELECT role_id FROM occ.iam_access_bindings WHERE identity_subject_id = $1`,
        [identity.rows[0].id],
      );
      assert.equal(bootstrapServicePrincipal.rows[0].role_id, humanBinding.rows[0].role_id);
      const storedServiceKey = await pool.query(
        `SELECT key, reference_id, name, metadata
         FROM occ.apikey WHERE id = $1`,
        [serviceKeyOutput.data.id],
      );
      assert.equal(storedServiceKey.rowCount, 1);
      assert.notEqual(storedServiceKey.rows[0].key, serviceKeyOutput.data.key);
      assert.equal(storedServiceKey.rows[0].reference_id, serviceKeyOutput.data.servicePrincipalId);
      assert.equal(storedServiceKey.rows[0].name, "bootstrap-admin");
      assert.deepEqual(JSON.parse(storedServiceKey.rows[0].metadata), {
        installationId: installation.rows[0].id,
      });
      const leakedAudit = await pool.query(
        `SELECT count(*)::integer AS count
         FROM occ.audit_events
         WHERE details::text LIKE $1 OR details::text LIKE $2 OR details::text LIKE $3`,
        [`%${password}%`, `%${account.rows[0].password}%`, `%${serviceKeyOutput.data.key}%`],
      );
      assert.equal(leakedAudit.rows[0].count, 0);

      // The application role cannot gain schema ownership through authentication or bootstrap.
      const privileges = await pool.query(
        "SELECT has_schema_privilege(current_user, 'occ', 'CREATE') AS can_create_schema",
      );
      assert.equal(privileges.rows[0].can_create_schema, false);

      const apiLog = memoryLog();
      const startupPhases = [];
      app = await composeProduction({
        mode: "production",
        host: "127.0.0.1",
        databaseUrl,
        authSecret,
        authBaseURL,
        onStartupPhase: (phase, durationMs) => startupPhases.push({ phase, durationMs }),
        // Leftover pilot settings must not change authentication when the feature is disabled.
        nativeAdmin: {
          enabled: false,
          domain: "agents.example.test",
          sharedCookieDomain: "example.test",
        },
        drivers: await productionDrivers({
          includeDefaults: true,
          configurationRoot: join(passwordDirectory, "configurations"),
        }),
        logger: apiLog.logger,
      });
      assert.deepEqual(
        apiLog.lines
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
        ["database", "authentication", "identity", "computePreflight", "controller", "routes"],
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
      assert.match(session.cookie, /(?:^|; )openclaw_occ\.session_token=/);
      assert.doesNotMatch(session.cookie, /openclaw_occ_shared/);
      assert.doesNotMatch(session.setCookie.join("\n"), /Domain=/i);

      const anonymousSession = await fetch(`${endpoint}/api/auth/session`);
      assert.equal(anonymousSession.status, 200);
      assert.equal((await anonymousSession.json()).data, null);

      // The optional session endpoint must never turn its HttpOnly cookie into a readable bearer token.
      const sessionResponse = await fetch(`${endpoint}/api/auth/session`, {
        headers: authenticatedHeaders(session),
      });
      assert.equal(sessionResponse.status, 200);
      const visibleSession = await sessionResponse.text();
      const activeSession = await pool.query("SELECT token FROM occ.session WHERE user_id = $1", [
        user.rows[0].id,
      ]);
      assert.equal(activeSession.rows.length, 1);
      assert.doesNotMatch(visibleSession, /token|password|credential/i);
      assert.equal(visibleSession.includes(activeSession.rows[0].token), false);
      assert.equal(visibleSession.includes(session.cookie), false);

      const authorized = await fetch(`${endpoint}/installation`, {
        headers: authenticatedHeaders(session),
      });
      assert.equal(authorized.status, 200);
      assert.equal((await authorized.json()).data.id, installation.rows[0].id);
      const serviceAuthorized = await fetch(`${endpoint}/installation`, {
        headers: { "x-api-key": serviceKeyOutput.data.key },
      });
      assert.equal(serviceAuthorized.status, 200);
      assert.equal((await serviceAuthorized.json()).data.id, installation.rows[0].id);

      // Prove all production ServiceAccount grants through the real cookie-authenticated HTTP boundary.
      async function request(method, path, payload, caller = session) {
        const response = await fetch(`${endpoint}${path}`, {
          method,
          headers: authenticatedHeaders(caller, {
            // This fixture configures port 0 before listening on an ephemeral port.
            origin: authBaseURL,
            ...(payload === undefined ? {} : { "content-type": "application/json" }),
          }),
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        });
        return {
          status: response.status,
          ...(response.status === 204 ? {} : { data: (await response.json()).data }),
        };
      }

      const presetPath = `/namespaces/${defaultNamespace[0].id}/presets`;
      const defaults = await request("GET", presetPath);
      assert.equal(defaults.status, 200);
      assert.deepEqual(defaults.data.map((preset) => preset.name).sort(), [
        "Standard Codex",
        "Standard OpenClaw",
        "default-codex",
      ]);
      const copied = defaults.data.find((preset) => preset.name === "Standard Codex");
      const copiedOpenClaw = defaults.data.find((preset) => preset.name === "Standard OpenClaw");
      assert.ok(copied, "missing Standard Codex");
      assert.ok(copiedOpenClaw, "missing Standard OpenClaw");
      const worker = createControllerWorker({
        pool: new pg.Pool({ connectionString: databaseUrl }),
        mode: "production",
        drivers: await productionDrivers(),
        pollIntervalMs: 20,
        emit: () => {},
      });
      try {
        await worker.start();
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          const current = await request("GET", `/namespaces/${defaultNamespace[0].id}`);
          if (current.data.status === "ready") {
            break;
          }
          await delay(20);
        }
        assert.equal(
          (await request("GET", `/namespaces/${defaultNamespace[0].id}`)).data.status,
          "ready",
        );
      } finally {
        await worker.stop();
      }
      const customized = await request("PATCH", `${presetPath}/${copied.id}`, {
        template: { agent: { name: "Kept across restart" } },
      });
      assert.equal(customized.status, 200);
      // Roll Standard OpenClaw back to an earlier shipped version, as a Namespace seeded
      // by that release holds it. The restart below must refresh it in place.
      const archivedPreset = async (path) =>
        JSON.parse(
          await readFile(new URL(`../../deploy/presets/archive/${path}`, import.meta.url), "utf8"),
        );
      const earlierOpenClaw = await archivedPreset("standard-openclaw/ed4bae5153f86b94.json");
      const rolledBack = await request("PATCH", `${presetPath}/${copiedOpenClaw.id}`, {
        template: earlierOpenClaw.template,
      });
      assert.equal(rolledBack.status, 200);
      assert.notDeepEqual(rolledBack.data.template, copiedOpenClaw.template);
      const restart = async (drivers, logger) => {
        await app.close();
        app = await composeProduction({
          mode: "production",
          host: "127.0.0.1",
          databaseUrl,
          authSecret,
          authBaseURL,
          drivers: await productionDrivers({
            ...drivers,
            configurationRoot: join(passwordDirectory, "configurations"),
          }),
          ...(logger === undefined ? {} : { logger }),
        });
        endpoint = await app.listen({ port: 0, host: "127.0.0.1" });
      };
      const readOpenClaw = async () =>
        (await request("GET", `${presetPath}/${copiedOpenClaw.id}`)).data;
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
      assert.deepEqual(afterRestart.data.map((preset) => preset.name).sort(), [
        "Standard Codex",
        "Standard OpenClaw",
        "default-codex",
      ]);
      assert.deepEqual(
        afterRestart.data.find((preset) => preset.name === "Standard Codex"),
        customized.data,
      );
      // Refreshed from the stored JSONB: same ID, current template. The edit above stays.
      assert.deepEqual(
        afterRestart.data.find((preset) => preset.name === "Standard OpenClaw"),
        copiedOpenClaw,
      );
      // A Restriction freezing the Namespace's Presets keeps an earlier copy, and startup
      // only warns. It stays for the rest of this test, which never updates these Presets.
      const refrozen = await request("PATCH", `${presetPath}/${copiedOpenClaw.id}`, {
        template: earlierOpenClaw.template,
      });
      assert.equal(refrozen.status, 200);
      const freezeId = `freeze-presets-${randomUUID()}`;
      await pool.query(
        "INSERT INTO occ.iam_restrictions (id, namespace_id, action, resource_kind) VALUES ($1, $2, 'update', 'preset')",
        [freezeId, defaultNamespace[0].id],
      );
      const skippedRefreshes = ({ lines }) =>
        lines
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
          namespaceId: defaultNamespace[0].id,
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
      const development = await composePostgresDevelopment(
        {
          mode: "development",
          host: "127.0.0.1",
          databaseUrl,
          authSecret,
          authBaseURL,
          logger: developmentLog.logger,
        },
        await productionDrivers({
          includeDefaults: true,
          configurationRoot: join(passwordDirectory, "configurations"),
        }),
      );
      await development.close();
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
        (await request("GET", presetPath)).data.find((preset) => preset.name === "default-codex");
      const seededCodex = await bundledCodexCopy();
      const shadowLog = memoryLog();
      await restart({ includeDefaults: true, files: [operatorCodexPath] }, shadowLog.logger);
      // The copy seeded earlier from the bundled template stays as it was.
      assert.deepEqual(await bundledCodexCopy(), seededCodex);
      assert.deepEqual(
        shadowLog.lines
          .filter(({ event }) => event === "presets.bundled-default-shadowed")
          .map(({ severity, presetName, presetFile }) => ({ severity, presetName, presetFile })),
        [{ severity: "WARN", presetName: "default-codex", presetFile: operatorCodexPath }],
      );
      const newNamespace = await request("POST", "/namespaces", {
        name: "Preset startup namespace",
      });
      assert.equal(newNamespace.status, 201);
      const newPresets = await request("GET", `/namespaces/${newNamespace.data.id}/presets`);
      assert.deepEqual(newPresets.data.map((preset) => preset.name).sort(), [
        "Standard Codex",
        "Standard OpenClaw",
        "default-codex",
      ]);
      // A new Namespace receives the operator's template, not the bundled one.
      assert.equal(
        newPresets.data.find((preset) => preset.name === "default-codex").template.agent.name,
        operatorCodexTemplate.agent.name,
      );
      assert.notEqual(
        newPresets.data.find((preset) => preset.name === "Standard Codex").id,
        copied.id,
      );
      assert.notEqual(
        newPresets.data.find((preset) => preset.name === "Standard OpenClaw").id,
        copiedOpenClaw.id,
      );
      // An earlier release seeded this default under a name the bundle no longer ships.
      // The Namespace is still provisioning, so write the row as that seeding did.
      const earlierCodex = await archivedPreset("standard-codex/a07d1e2070d95c99.json");
      await pool.query(
        "INSERT INTO occ.presets (id, namespace_id, name, template, created_at) VALUES ($1, $2, $3, $4, now())",
        [
          `pre_${randomUUID()}`,
          newNamespace.data.id,
          earlierCodex.name,
          JSON.stringify(normalizePresetTemplate(earlierCodex.template, newNamespace.data.id)),
        ],
      );
      // Only unmodified seeded defaults remain, so deletion removes them with the Namespace.
      const deletedNamespace = await request("DELETE", `/namespaces/${newNamespace.data.id}`);
      assert.equal(deletedNamespace.status, 202);
      assert.equal(deletedNamespace.data.status, "deleting");
      const remainingPresets = await pool.query(
        "SELECT id FROM occ.presets WHERE namespace_id = $1",
        [newNamespace.data.id],
      );
      assert.deepEqual(remainingPresets.rows, []);

      const defaultConfiguration = await request(
        "POST",
        `/namespaces/${defaultNamespace[0].id}/configurations`,
        {
          kind: "agent",
          values: { model: "preserved-default" },
        },
      );
      assert.equal(defaultConfiguration.status, 201);
      const defaultAgent = await request("POST", `/namespaces/${defaultNamespace[0].id}/agents`, {
        name: `default-agent-${randomUUID()}`,
        configurationId: defaultConfiguration.data.id,
      });
      assert.equal(defaultAgent.status, 201);
      const persistedDefaultNamespace = await request(
        "GET",
        `/namespaces/${defaultNamespace[0].id}`,
      );
      assert.equal(persistedDefaultNamespace.status, 200);
      const persistedDefaultConfiguration = await request(
        "GET",
        `/namespaces/${defaultNamespace[0].id}/configurations/${defaultConfiguration.data.id}`,
      );
      assert.equal(persistedDefaultConfiguration.status, 200);
      assert.deepEqual(persistedDefaultConfiguration.data.values, {
        model: "preserved-default",
      });
      const persistedDefaultAgent = await request(
        "GET",
        `/namespaces/${defaultNamespace[0].id}/agents/${defaultAgent.data.id}`,
      );
      assert.equal(persistedDefaultAgent.status, 200);
      assert.equal(persistedDefaultAgent.data.configurationId, defaultConfiguration.data.id);
      const repeatAfterUserState = await run(
        process.execPath,
        ["scripts/bootstrap-installation.mjs"],
        {
          cwd: repository,
          env: existingOnlyEnvironment,
        },
      );
      assert.match(repeatAfterUserState.stdout, /installation\.already-bootstrapped/);
      assert.deepEqual(
        await defaultNamespaceRows(pool),
        defaultNamespace.map((namespace) => ({ ...namespace, status: "ready" })),
      );
      assert.deepEqual(
        await request("GET", `/namespaces/${defaultNamespace[0].id}`),
        persistedDefaultNamespace,
      );
      assert.deepEqual(
        await request(
          "GET",
          `/namespaces/${defaultNamespace[0].id}/configurations/${defaultConfiguration.data.id}`,
        ),
        persistedDefaultConfiguration,
      );
      assert.deepEqual(
        await request(
          "GET",
          `/namespaces/${defaultNamespace[0].id}/agents/${defaultAgent.data.id}`,
        ),
        persistedDefaultAgent,
      );

      const namespace = await request("POST", "/namespaces", {
        name: `production-service-account-${randomUUID()}`,
      });
      assert.equal(namespace.status, 201);
      const accountsPath = `/namespaces/${namespace.data.id}/service-accounts`;
      const createdAccount = await request("POST", accountsPath, {
        name: "production-model-provider",
      });
      assert.equal(createdAccount.status, 201);
      const accountPath = `${accountsPath}/${createdAccount.data.id}`;
      assert.deepEqual((await request("GET", accountPath)).data, createdAccount.data);
      const credential = {
        kind: "api_key",
        secretRef: { name: "production-model-source", key: "provider-api-key" },
      };
      const updatedAccount = await request("PATCH", `${accountPath}/credential`, credential);
      assert.equal(updatedAccount.status, 200);
      assert.deepEqual(updatedAccount.data, {
        ...createdAccount.data,
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
      const serviceNamespace = await fetch(`${endpoint}/namespaces`, {
        method: "POST",
        headers: {
          "x-api-key": serviceKeyOutput.data.key,
          "content-type": "application/json",
        },
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
        async () => {
          // Account enrollment is a precondition, not the behavior under test. Seed an
          // existing Installation-reader Role, then provision people through the real API.
          // Their initial Role grants no Namespace, Agent, or policy administration access.
          const readerRoleId = `role-reader-${randomUUID()}`;
          await pool.query(
            "INSERT INTO occ.iam_roles (id, name, permissions) VALUES ($1, $2, $3)",
            [
              readerRoleId,
              "Installation reader",
              JSON.stringify([{ action: "read", resourceKind: "installation" }]),
            ],
          );
          const people = [];
          for (const label of ["recipient", "unaffected"]) {
            const email = `${label}-${randomUUID()}@example.test`;
            const personPassword = `sharing-${randomUUID()}`;
            const created = await request("POST", "/api/auth/accounts", {
              email,
              password: personPassword,
              name: label,
              roleId: readerRoleId,
            });
            assert.equal(created.status, 201);
            const personSession = await signInWithEmailPassword({
              origin: endpoint,
              email,
              password: personPassword,
            });
            people.push({ principalId: created.data.principalId, session: personSession });
            assert.deepEqual(
              (await request("GET", "/namespaces", undefined, personSession)).data,
              [],
            );
          }
          const namespaceId = defaultNamespace[0].id;
          const agentId = defaultAgent.data.id;
          const agentsPath = `/namespaces/${namespaceId}/agents`;
          const policyPath = `/namespaces/${namespaceId}/iam`;
          const sibling = await request("POST", agentsPath, {
            name: `private-sibling-${randomUUID()}`,
            configurationId: defaultConfiguration.data.id,
          });
          assert.equal(sibling.status, 201);
          const discoveryRole = await request("POST", `${policyPath}/roles`, {
            name: "Namespace discovery",
            permissions: [{ action: "read", resourceKind: "namespace" }],
          });
          const agentRole = await request("POST", `${policyPath}/roles`, {
            name: "Agent native administration",
            permissions: [
              { action: "read", resourceKind: "agent" },
              { action: "administer", resourceKind: "agent" },
            ],
          });
          assert.equal(discoveryRole.status, 201);
          assert.equal(agentRole.status, 201);
          const bindings = [];
          for (const person of people) {
            assert.equal(
              (await request("GET", `${agentsPath}/${agentId}`, undefined, person.session)).status,
              403,
            );
            // Use the same exact-scope API sequence as Console sharing. An account's
            // ability to sign in does not by itself grant discovery or sibling access.
            for (const [resourceKind, resourceId, roleId] of [
              ["namespace", namespaceId, discoveryRole.data.id],
              ["agent", agentId, agentRole.data.id],
            ]) {
              const binding = await request("POST", `${policyPath}/access-bindings`, {
                subjectKind: "identity",
                subjectId: person.principalId,
                roleId,
                resourceKind,
                resourceId,
              });
              assert.equal(binding.status, 201);
              if (resourceKind === "agent") {
                bindings.push(binding.data);
              }
            }
          }

          // A fresh application and IAM instance must reconstruct both authority and
          // sessions from PostgreSQL. Keep the same cookies; do not mint fixture sessions.
          await app.close();
          app = await composeProduction({
            mode: "production",
            host: "127.0.0.1",
            databaseUrl,
            authSecret,
            authBaseURL,
            drivers: await productionDrivers(),
            logger: apiLog.logger,
          });
          endpoint = await app.listen({ port: 0, host: "127.0.0.1" });
          for (const person of people) {
            const namespaces = await request("GET", "/namespaces", undefined, person.session);
            assert.equal(namespaces.status, 200);
            assert.deepEqual(
              namespaces.data.map(({ id }) => id),
              [namespaceId],
            );
            const agents = await request("GET", agentsPath, undefined, person.session);
            assert.equal(agents.status, 200);
            assert.deepEqual(
              agents.data.map(({ id }) => id),
              [agentId],
            );
            assert.equal(
              (await request("GET", `${agentsPath}/${agentId}`, undefined, person.session)).status,
              200,
            );
            assert.equal(
              (await request("GET", `${agentsPath}/${sibling.data.id}`, undefined, person.session))
                .status,
              403,
            );
            assert.equal(
              (
                await request(
                  "GET",
                  `/namespaces/${namespaceId}/configurations/${defaultConfiguration.data.id}`,
                  undefined,
                  person.session,
                )
              ).status,
              403,
            );
            assert.equal(
              (await request("GET", `${policyPath}/roles`, undefined, person.session)).status,
              403,
            );
          }

          const [recipient, unaffected] = people;
          const revoked = await request(
            "DELETE",
            `${policyPath}/access-bindings/${bindings[0].id}`,
          );
          assert.equal(revoked.status, 204);
          // Check the next real authenticated HTTP request, not a manufactured abort or
          // changed cookie. This does not claim closure of an already-open native stream.
          assert.equal(
            (await request("GET", `${agentsPath}/${agentId}`, undefined, recipient.session)).status,
            403,
          );
          assert.deepEqual(
            (await request("GET", agentsPath, undefined, recipient.session)).data,
            [],
          );
          assert.deepEqual(
            (await request("GET", "/namespaces", undefined, recipient.session)).data.map(
              ({ id }) => id,
            ),
            [namespaceId],
          );
          assert.equal(
            (await request("GET", `${agentsPath}/${agentId}`, undefined, unaffected.session))
              .status,
            200,
          );
          const remaining = await request("GET", `${policyPath}/access-bindings`);
          assert.equal(remaining.status, 200);
          assert.equal(
            remaining.data.some(({ id }) => id === bindings[0].id),
            false,
          );
          assert.equal(
            remaining.data.some(({ id }) => id === bindings[1].id),
            true,
          );
        },
      );
    } finally {
      if (app !== undefined) {
        await app.close();
      }
      if (pool !== undefined) {
        await pool.end();
      }
      await rm(passwordDirectory, { recursive: true, force: true });
    }
  },
);
