import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { createOccLogger } from "../../apps/controller/src/logging.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { authenticatedHeaders, signInWithEmailPassword } from "../helpers/auth-session.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
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

async function productionDrivers({ includeDefaults = false, configurationRoot } = {}) {
  const configuration = createInstallationDriverConfiguration();
  configuration.presets = { includeDefaults };
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
  async () => {
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
      app = await composeProduction({
        mode: "production",
        host: "127.0.0.1",
        databaseUrl,
        authSecret,
        authBaseURL,
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
      async function request(method, path, payload) {
        const response = await fetch(`${endpoint}${path}`, {
          method,
          headers: authenticatedHeaders(
            session,
            payload === undefined ? {} : { "content-type": "application/json" },
          ),
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
        "standard-codex",
        "standard-openclaw",
      ]);
      const copied = defaults.data.find((preset) => preset.name === "standard-codex");
      const copiedOpenClaw = defaults.data.find((preset) => preset.name === "standard-openclaw");
      assert.ok(copied, "missing standard-codex");
      assert.ok(copiedOpenClaw, "missing standard-openclaw");
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
      await app.close();
      app = await composeProduction({
        mode: "production",
        host: "127.0.0.1",
        databaseUrl,
        authSecret,
        authBaseURL,
        drivers: await productionDrivers({
          includeDefaults: true,
          configurationRoot: join(passwordDirectory, "configurations"),
        }),
      });
      endpoint = await app.listen({ port: 0, host: "127.0.0.1" });
      const afterRestart = await request("GET", presetPath);
      assert.deepEqual(afterRestart.data.map((preset) => preset.name).sort(), [
        "standard-codex",
        "standard-openclaw",
      ]);
      assert.deepEqual(
        afterRestart.data.find((preset) => preset.name === "standard-codex"),
        customized.data,
      );
      assert.deepEqual(
        afterRestart.data.find((preset) => preset.name === "standard-openclaw"),
        copiedOpenClaw,
      );
      const newNamespace = await request("POST", "/namespaces", {
        name: "Preset startup namespace",
      });
      assert.equal(newNamespace.status, 201);
      const newPresets = await request("GET", `/namespaces/${newNamespace.data.id}/presets`);
      assert.deepEqual(newPresets.data.map((preset) => preset.name).sort(), [
        "standard-codex",
        "standard-openclaw",
      ]);
      assert.notEqual(
        newPresets.data.find((preset) => preset.name === "standard-codex").id,
        copied.id,
      );
      assert.notEqual(
        newPresets.data.find((preset) => preset.name === "standard-openclaw").id,
        copiedOpenClaw.id,
      );

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
