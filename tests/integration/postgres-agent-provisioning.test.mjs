import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  OpenClawController,
  PostgresPlatformState,
  PostgresWorkQueue,
  createProvisioningInputProtector,
} from "../../packages/occ/src/index.ts";
import { composePostgresDevelopment } from "../../apps/controller/src/composition/development-postgres.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.mjs";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { waitFor } from "../helpers/postgres-provider-state.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const adminEmail = "postgres-agent-provisioning-v2@example.test";
const adminPassword = "postgres-agent-provisioning-password";
const authBaseURL = "http://127.0.0.1";
const authSecret = "postgres-agent-provisioning-auth-secret-32-bytes";
let bootstrapPromise;
const requiresPostgres = {
  skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL to run real PostgreSQL integration tests.",
};
const uuidV4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const identifier = (prefix) => new RegExp(`^${prefix}_${uuidV4}$`);

function requestId() {
  return `req_${randomUUID()}`;
}

function provisioningBody(overrides = {}) {
  return {
    requestId: overrides.requestId ?? requestId(),
    name: overrides.name ?? `Provisioned ${randomUUID().slice(0, 8)}`,
    executionMode: "dedicated",
    configuration: {
      kind: "agent",
      values: {
        agents: { defaults: { model: "codex/gpt-6-astra" } },
        channels: {
          slack: {
            enabled: true,
            botTokenEnv: "SLACK_BOT_TOKEN",
            signingSecretEnv: "SLACK_SIGNING_SECRET",
          },
        },
      },
      secretBindings: {
        SLACK_BOT_TOKEN: {
          source: { kind: "provisioning-secret", name: "slack-bot-token" },
          delivery: { type: "env" },
        },
        SLACK_SIGNING_SECRET: {
          source: { kind: "provisioning-secret", name: "slack-signing-secret" },
          delivery: { type: "env" },
        },
        EXTERNAL_SERVICE_TOKEN: {
          source: { kind: "provisioning-secret", name: "external-service-token" },
        },
      },
    },
    harnessAuth: {
      method: "api_key",
      source: { kind: "provisioning-secret", name: "model-api-key" },
    },
    secrets: [
      { name: "model-api-key", value: `model-secret-${randomUUID()}` },
      { name: "slack-bot-token", value: `xoxb-${randomUUID()}` },
      { name: "slack-signing-secret", value: `slack-signing-${randomUUID()}` },
      { name: "external-service-token", value: `external-${randomUUID()}` },
    ],
    initialWorkspaceFiles: {
      "AGENTS.md": "Use the inline workspace setup from provisioning.",
    },
    ...overrides,
  };
}

function createProtector() {
  return createProvisioningInputProtector({
    primaryKeyId: "test-v1",
    keys: [{ id: "test-v1", material: randomBytes(32).toString("base64url") }],
  });
}

function createRuntimeComputeDriver(options = {}) {
  const base = createDevelopmentComputeDriver();
  const calls = [];
  const runtimeStatus = new Map();
  const keyOf = ({ namespace, agent }) => `${namespace.id}:${agent.id}`;
  return {
    ...base,
    agentProvisioning: { executionModes: ["dedicated"] },
    calls,
    validateAgentProvisioning(input) {
      if (input.executionMode !== "dedicated") {
        throw new Error("Test provisioning supports only dedicated Agents.");
      }
    },
    async prepareRevision(revision, context) {
      calls.push({
        operation: "prepareRevision",
        revisionId: revision.id,
        agentId: revision.agentId,
      });
      return base.prepareRevision(revision, context);
    },
    async provisionAgentRuntimeCredentials(binding, input) {
      calls.push({
        operation: "provisionAgentRuntimeCredentials",
        agentId: binding.agent.id,
        input,
      });
      runtimeStatus.set(keyOf(binding), { transportConfigured: true });
      return { transportConfigured: true };
    },
    async getAgentRuntimeCredentialStatus(binding) {
      calls.push({ operation: "getAgentRuntimeCredentialStatus", agentId: binding.agent.id });
      return runtimeStatus.get(keyOf(binding)) ?? { transportConfigured: false };
    },
    ...(options.prepareRevision === undefined ? {} : { prepareRevision: options.prepareRevision }),
  };
}

function createProvisioningConfigurationDriver(options) {
  const driver = createTestConfigurationDriver(options);
  driver.createExact = (configuration) => driver.create(configuration);
  return driver;
}

function createProvisioningSecretDriver(options) {
  const driver = createTestSecretDriver(options);
  driver.createExact = ({ identity, value }) => driver.create(identity, value);
  return driver;
}

async function privateBootstrapDirectory(context) {
  const directory = await mkdtemp("/private/tmp/openclaw-agent-provisioning-bootstrap-");
  await chmod(directory, 0o700);
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function ensureProvisioningBootstrap(context, state) {
  if ((await state.loadInstallation()) !== undefined) {
    return;
  }
  bootstrapPromise ??= (async () => {
    await ensureDevelopmentBootstrap(context, {
      databaseUrl,
      directory: await privateBootstrapDirectory(context),
      email: adminEmail,
      password: adminPassword,
      authSecret,
      authBaseURL,
      installationName: "Agent provisioning integration",
      environment: { PATH: process.env.PATH },
    });
  })();
  await bootstrapPromise;
}

function installationDrivers({ computeDriver, configurationDriver, secretDriver }) {
  return {
    installation: {
      occ: { cluster: "postgres-agent-provisioning" },
      logging: {},
      provider: [],
      drivers: {
        iam: { id: "native-iam", implementation: "native", configuration: {} },
        compute: {
          id: computeDriver.id,
          implementation: computeDriver.implementation,
          configuration: {},
        },
        configuration: {
          id: configurationDriver.id,
          implementation: configurationDriver.implementation,
          configuration: {},
        },
        secret: {
          id: secretDriver.id,
          implementation: secretDriver.implementation,
          configuration: {},
        },
      },
    },
    computeDriver,
    configurationDriver,
    secretDriver,
    createIAMDriver: (state) =>
      new NativeIAMDriver(state, { id: "native-iam", implementation: "native" }),
  };
}

async function createFixture(context, options = {}) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
  const workerPool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
  const state = new PostgresPlatformState(pool);
  await ensureProvisioningBootstrap(context, state);
  const credentials = { email: adminEmail, password: adminPassword };
  const computeDriver = options.computeDriver ?? createRuntimeComputeDriver();
  const configurationDriver =
    options.configurationDriver ??
    createProvisioningConfigurationDriver({ id: "configuration-provisioning" });
  const secretDriver =
    options.secretDriver ?? createProvisioningSecretDriver({ id: "secret-provisioning" });
  const protector = options.protector ?? createProtector();
  let worker;
  const drivers = installationDrivers({ computeDriver, configurationDriver, secretDriver });
  const app = await composePostgresDevelopment(
    {
      mode: "development",
      host: "127.0.0.1",
      databaseUrl,
      authSecret,
      authBaseURL,
      provisioningInputProtector: protector,
    },
    drivers,
  );
  const session = await signInToControllerApp(app, credentials);

  context.after(async () => {
    await stopWorker();
    await app.close?.();
    await workerPool.end();
    await pool.end();
  });

  async function request(method, path, { body, session: selectedSession = session } = {}) {
    const headers = {
      ...(selectedSession === null ? {} : authenticatedHeaders(selectedSession)),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(method === "GET" ? {} : { origin: "http://127.0.0.1" }),
      host: "127.0.0.1",
    };
    const response = await app.inject({
      method,
      url: path,
      headers,
      remoteAddress: "127.0.0.1",
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    const text = response.body;
    const payload = text.length === 0 ? undefined : JSON.parse(text);
    if (payload !== undefined) {
      assert.match(payload.meta?.requestId ?? "", identifier("req"));
    }
    return {
      status: response.statusCode,
      body: payload,
      data: payload?.data,
      error: payload?.error,
    };
  }

  async function bootstrapNamespace() {
    const namespace = await request("POST", "/namespaces", {
      body: { name: `agent-provisioning-${randomUUID().slice(0, 8)}` },
    });
    assert.equal(namespace.status, 201, JSON.stringify(namespace.body));
    await startWorker();
    try {
      return await waitFor(`Namespace ${namespace.data.id} to become ready`, async () => {
        const observed = await request("GET", `/namespaces/${namespace.data.id}`);
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        return observed.data.status === "ready" ? observed.data : undefined;
      });
    } finally {
      await stopWorker();
    }
  }

  async function startWorker() {
    assert.equal(worker, undefined, "the fixture worker is already running");
    worker = createControllerWorker({
      pool: workerPool,
      drivers,
      provisioningInputProtector: protector,
      pollIntervalMs: 15,
      leaseDurationMs: 30_000,
      maxAttempts: 3,
      emit: () => {},
    });
    await worker.start();
  }

  async function stopWorker() {
    if (worker === undefined) {
      return;
    }
    const current = worker;
    worker = undefined;
    await current.stop();
  }

  async function revokeCurrentPrincipal() {
    const iam = await state.loadNativeIAMState();
    const principal = iam.identities.find(
      (identity) => identity.kind === "principal" && identity.issuer.endsWith("/api/auth"),
    );
    assert.ok(principal, "the bootstrapped administrator Principal must exist");
    const result = await pool.query(
      `DELETE FROM occ.iam_access_bindings
       WHERE identity_subject_id = $1
         AND namespace_id IS NULL
         AND resource_kind = 'installation'
       RETURNING id`,
      [principal.id],
    );
    assert.ok(result.rowCount > 0, "revocation must remove the exact administrator binding");
  }

  return {
    app,
    bootstrapNamespace,
    computeDriver,
    pool,
    protector,
    configurationDriver,
    revokeCurrentPrincipal,
    request,
    secretDriver,
    session,
    startWorker,
    state,
    stopWorker,
    workerPool,
  };
}

async function createDirectProvisioningController(fixture) {
  const installation = await fixture.state.loadInstallation();
  assert.ok(installation, "the bootstrapped Installation must exist");
  const controller = new OpenClawController(installation, {
    state: fixture.state,
    recordOperations: true,
    provisioningInputProtector: fixture.protector,
  });
  const iamDriver = new NativeIAMDriver(fixture.state, {
    id: "native-iam",
    implementation: "native",
  });
  controller.registerDriver(iamDriver);
  controller.selectDriver("iam", iamDriver.id);
  controller.registerDriver(fixture.computeDriver);
  controller.selectDriver("compute", fixture.computeDriver.id);
  controller.registerDriver(fixture.configurationDriver);
  controller.selectDriver("configuration", fixture.configurationDriver.id);
  controller.registerDriver(fixture.secretDriver);
  controller.selectDriver("secret", fixture.secretDriver.id);
  return controller;
}

async function provisioningRow(pool, namespaceId, requestId) {
  const result = await pool.query(
    "SELECT * FROM occ.agent_provisioning_work WHERE namespace_id = $1 AND request_id = $2",
    [namespaceId, requestId],
  );
  assert.equal(result.rowCount, 1, "provisioning admission must persist one request record");
  return result.rows[0];
}

test(
  "provisioning API protects inline secrets, admits one stopped Agent, and replays only the exact same request",
  requiresPostgres,
  async (context) => {
    const fixture = await createFixture(context);
    const namespace = await fixture.bootstrapNamespace();
    const body = provisioningBody();

    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    assert.equal(admitted.data.agent.name, body.name);
    assert.equal(admitted.data.agent.namespaceId, namespace.id);
    assert.equal(admitted.data.agent.harnessAuth, null);
    assert.equal(admitted.data.agent.desiredRuntimeState, "stopped");
    assert.deepEqual(admitted.data.provisioning, {
      status: "queued",
      phase: "admitted",
      attemptCount: 0,
      updatedAt: admitted.data.provisioning.updatedAt,
      url: `/namespaces/${namespace.id}/agents/${admitted.data.agent.id}/provisioning`,
    });
    assert.equal(Number.isNaN(Date.parse(admitted.data.provisioning.updatedAt)), false);
    const status = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/agents/${admitted.data.agent.id}/provisioning`,
    );
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.deepEqual(status.data, admitted.data.provisioning);
    assert.equal(
      JSON.stringify(admitted.body).includes(body.secrets[0].value),
      false,
      "Secret values must not echo from admission",
    );
    const serializedPublicResponses = JSON.stringify([admitted.body, status.body]);
    for (const secret of body.secrets) {
      assert.equal(serializedPublicResponses.includes(secret.value), false);
    }
    const audit = await fixture.pool.query(
      `SELECT action, outcome, details
       FROM occ.audit_events
       WHERE namespace_id = $1
         AND resource_kind = 'agent'
         AND resource_id = $2
       ORDER BY occurred_at, id`,
      [namespace.id, admitted.data.agent.id],
    );
    assert.ok(audit.rowCount > 0, "provisioning admission must append durable audit evidence");
    const serializedAudit = JSON.stringify(audit.rows);
    for (const secret of body.secrets) {
      assert.equal(serializedAudit.includes(secret.value), false);
    }

    const row = await provisioningRow(fixture.pool, namespace.id, body.requestId);
    assert.equal(row.agent_id, admitted.data.agent.id);
    assert.equal(row.phase, "queued");
    assert.equal(JSON.stringify(row).includes(body.secrets[1].value), false);
    assert.notEqual(row.fingerprint, body.secrets[1].value);

    const replay = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(replay.status, 202, JSON.stringify(replay.body));
    assert.equal(replay.data.agent.id, admitted.data.agent.id);

    const changed = structuredClone(body);
    changed.secrets[1] = { ...changed.secrets[1], value: `changed-${randomUUID()}` };
    const rejected = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body: changed,
    });
    assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
    assert.equal(rejected.error.code, "RESOURCE_CONFLICT");
  },
);

test(
  "provisioning worker creates generic Secrets, finalizes Configuration, provisions transport, and hands off one revision",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const fixture = await createFixture(context);
    const namespace = await fixture.bootstrapNamespace();
    const body = provisioningBody();
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));

    await fixture.startWorker();
    const status = await waitFor("Agent provisioning to succeed", async () => {
      const observed = await fixture.request(
        "GET",
        `/namespaces/${namespace.id}/agents/${admitted.data.agent.id}/provisioning`,
      );
      assert.equal(observed.status, 200, JSON.stringify(observed.body));
      return observed.data.status === "succeeded" ? observed.data : undefined;
    });
    assert.equal(status.status, "succeeded");

    const secrets = await fixture.pool.query(
      "SELECT id, name FROM occ.secrets WHERE namespace_id = $1 ORDER BY name",
      [namespace.id],
    );
    assert.deepEqual(
      secrets.rows.map(({ name }) => name),
      body.secrets.map(({ name }) => name).sort(),
    );
    const configuration = await fixture.pool.query(
      "SELECT generation, secret_bindings FROM occ.configurations WHERE namespace_id = $1 AND id = $2",
      [namespace.id, admitted.data.agent.configurationId],
    );
    assert.equal(configuration.rowCount, 1);
    assert.equal(configuration.rows[0].generation, 2);
    assert.deepEqual(Object.keys(configuration.rows[0].secret_bindings).sort(), [
      "EXTERNAL_SERVICE_TOKEN",
      "SLACK_BOT_TOKEN",
      "SLACK_SIGNING_SECRET",
    ]);
    const revisions = await fixture.pool.query(
      "SELECT id, configuration_generation, harness_auth, secret_bindings FROM occ.agent_revisions WHERE namespace_id = $1 AND agent_id = $2",
      [namespace.id, admitted.data.agent.id],
    );
    assert.equal(revisions.rowCount, 1);
    assert.equal(revisions.rows[0].configuration_generation, 2);
    assert.equal(revisions.rows[0].harness_auth.method, "api_key");
    assert.deepEqual(
      fixture.computeDriver.calls.map(({ operation }) => operation),
      ["provisionAgentRuntimeCredentials", "prepareRevision"],
    );

    const work = await fixture.pool.query(
      "SELECT state FROM occ.controller_work WHERE work_kind = 'provisioning' AND namespace_id = $1 AND agent_id = $2",
      [namespace.id, admitted.data.agent.id],
    );
    assert.equal(work.rowCount, 1);
    assert.equal(work.rows[0].state, "completed");
  },
);

test(
  "provisioning cancellation stops before backend effects and leaves truthful status",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const secretDriver = createProvisioningSecretDriver({ id: "secret-provisioning-cancel" });
    const fixture = await createFixture(context, { secretDriver });
    const namespace = await fixture.bootstrapNamespace();
    const body = provisioningBody();
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));

    const stopped = await fixture.request(
      "POST",
      `/namespaces/${namespace.id}/agents/${admitted.data.agent.id}/stop`,
      { body: {} },
    );
    assert.equal(stopped.status, 202, JSON.stringify(stopped.body));

    await fixture.startWorker();
    const status = await waitFor("cancelled or failed provisioning status", async () => {
      const observed = await fixture.request(
        "GET",
        `/namespaces/${namespace.id}/agents/${admitted.data.agent.id}/provisioning`,
      );
      assert.equal(observed.status, 200, JSON.stringify(observed.body));
      return ["cancelled", "failed"].includes(observed.data.status) ? observed.data : undefined;
    });
    assert.match(status.error?.code ?? status.status, /CANCEL|STOP|AUTH|failed/i);
    assert.deepEqual(
      secretDriver.calls.map(({ operation }) => operation),
      [],
      "a stopped initial Agent must not create submitted Secret backend values",
    );
    const revisions = await fixture.pool.query(
      "SELECT id FROM occ.agent_revisions WHERE namespace_id = $1 AND agent_id = $2",
      [namespace.id, admitted.data.agent.id],
    );
    assert.equal(revisions.rowCount, 0);
  },
);

test(
  "provisioning worker reauthorizes after admission and revoked authority creates no backend effects",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const secretDriver = createProvisioningSecretDriver({ id: "secret-provisioning-revoked" });
    const fixture = await createFixture(context, { secretDriver });
    const namespace = await fixture.bootstrapNamespace();
    const body = provisioningBody();
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));

    await fixture.revokeCurrentPrincipal();
    await fixture.startWorker();
    const work = await waitFor("provisioning work to fail after authority revocation", async () => {
      const observed = await fixture.pool.query(
        "SELECT state, reason_code FROM occ.controller_work WHERE work_kind = 'provisioning' AND namespace_id = $1 AND agent_id = $2",
        [namespace.id, admitted.data.agent.id],
      );
      assert.equal(observed.rowCount, 1);
      return observed.rows[0].state === "failed_permanent" ? observed.rows[0] : undefined;
    });
    assert.ok(
      /AUTH|FORBIDDEN|DENIED/.test(work.reason_code ?? ""),
      `expected an authorization failure reason, got ${work.reason_code}`,
    );
    assert.deepEqual(
      secretDriver.calls.map(({ operation }) => operation),
      [],
      "revoked initiating authority must prevent submitted Secret backend creation",
    );
    const revisions = await fixture.pool.query(
      "SELECT id FROM occ.agent_revisions WHERE namespace_id = $1 AND agent_id = $2",
      [namespace.id, admitted.data.agent.id],
    );
    assert.equal(revisions.rowCount, 0);
  },
);

test(
  "failed provisioning can retry through the API and resume without duplicating the Agent",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const computeDriver = createRuntimeComputeDriver();
    const configurationDriver = createProvisioningConfigurationDriver({
      id: "configuration-provisioning-retry",
    });
    const createExact = configurationDriver.createExact;
    const fixture = await createFixture(context, { computeDriver, configurationDriver });
    const namespace = await fixture.bootstrapNamespace();
    const body = provisioningBody();
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));

    configurationDriver.createExact = undefined;
    await fixture.startWorker();
    const failed = await waitFor(
      "Agent provisioning to exhaust configuration retries",
      async () => {
        const observed = await fixture.request(
          "GET",
          `/namespaces/${namespace.id}/agents/${admitted.data.agent.id}/provisioning`,
        );
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        return observed.data.status === "failed" ? observed.data : undefined;
      },
    );
    assert.equal(failed.phase, "database_setup");
    assert.equal(failed.error?.code, "PROVISIONING_DEPENDENCY_UNAVAILABLE");
    assert.deepEqual(
      computeDriver.calls.map(({ operation }) => operation),
      [],
      "a pre-dispatch Configuration dependency failure must not reach transport effects",
    );
    await fixture.stopWorker();

    configurationDriver.createExact = createExact;
    const retried = await fixture.request(
      "POST",
      `/namespaces/${namespace.id}/agents/${admitted.data.agent.id}/provisioning/retry`,
      { body: {} },
    );
    assert.equal(retried.status, 202, JSON.stringify(retried.body));
    assert.equal(retried.data.status, "queued");
    assert.equal(retried.data.phase, "configuration");

    await fixture.startWorker();
    const succeeded = await waitFor("retried Agent provisioning to succeed", async () => {
      const observed = await fixture.request(
        "GET",
        `/namespaces/${namespace.id}/agents/${admitted.data.agent.id}/provisioning`,
      );
      assert.equal(observed.status, 200, JSON.stringify(observed.body));
      return observed.data.status === "succeeded" ? observed.data : undefined;
    });
    assert.equal(succeeded.revisionId?.startsWith("rev_"), true);

    const agents = await fixture.pool.query("SELECT id FROM occ.agents WHERE namespace_id = $1", [
      namespace.id,
    ]);
    assert.deepEqual(
      agents.rows.map(({ id }) => id),
      [admitted.data.agent.id],
      "retry must resume the accepted provisioning plan instead of creating a replacement Agent",
    );
    const revisions = await fixture.pool.query(
      "SELECT id FROM occ.agent_revisions WHERE namespace_id = $1 AND agent_id = $2",
      [namespace.id, admitted.data.agent.id],
    );
    assert.equal(revisions.rowCount, 1);
    assert.deepEqual(
      computeDriver.calls.map(({ operation }) => operation),
      ["provisionAgentRuntimeCredentials", "prepareRevision"],
    );
  },
);

test(
  "cancelled provisioning with a settled Secret receipt cleans up the exact backend",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const secretDriver = createProvisioningSecretDriver({ id: "secret-provisioning-cleanup" });
    const fixture = await createFixture(context, { secretDriver });
    const namespace = await fixture.bootstrapNamespace();
    const body = provisioningBody({
      secrets: [{ name: "model-api-key", value: `model-secret-${randomUUID()}` }],
      configuration: {
        kind: "agent",
        values: { agents: { defaults: { model: "codex/gpt-6-astra" } } },
      },
      harnessAuth: {
        method: "api_key",
        source: { kind: "provisioning-secret", name: "model-api-key" },
      },
    });
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));

    const queue = new PostgresWorkQueue(fixture.pool, {
      leaseDurationMs: 30_000,
      maxAttempts: 3,
    });
    const claim = await queue.claim();
    assert.ok(claim, "the admitted provisioning request must enqueue one work item");
    assert.equal(
      claim.idempotencyKey,
      (await provisioningRow(fixture.pool, namespace.id, body.requestId)).work_id,
    );
    const controller = await createDirectProvisioningController(fixture);
    let cancelled = false;
    const result = await controller.processAgentProvisioning(claim, resolveApprovedHarness, {
      runEffect: async (operation) => {
        const value = await operation(new AbortController().signal);
        if (!cancelled) {
          cancelled = true;
          const stopped = await fixture.request(
            "POST",
            `/namespaces/${namespace.id}/agents/${admitted.data.agent.id}/stop`,
            { body: {} },
          );
          assert.equal(stopped.status, 202, JSON.stringify(stopped.body));
          throw new Error("synthetic post-receipt cancellation");
        }
        return value;
      },
    });
    assert.deepEqual(result, {
      outcome: "permanent",
      code: "PROVISIONING_CANCELLED",
    });
    assert.deepEqual(
      secretDriver.calls.map(({ operation }) => operation),
      ["create", "delete"],
      "a settled Secret receipt must clean up the exact backend after cancellation",
    );
    const persistedSecrets = await fixture.pool.query(
      "SELECT id FROM occ.secrets WHERE namespace_id = $1",
      [namespace.id],
    );
    assert.equal(persistedSecrets.rowCount, 0);
  },
);
