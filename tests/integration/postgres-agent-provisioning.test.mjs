import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";

import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { composePostgresDevelopment } from "../../apps/controller/src/composition/development-postgres.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { GitHubRepoDriver } from "../../apps/controller/src/drivers/repo/github/driver.ts";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.mjs";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { waitFor } from "../helpers/postgres-backend-state.mjs";

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
const defaultModel = "codex/gpt-6-astra";

function agentDefaults() {
  return {
    model: defaultModel,
    models: { [defaultModel]: { agentRuntime: { id: "codex" } } },
  };
}

function requestId() {
  return `req_${randomUUID()}`;
}

function secretRef(namespaceId, id) {
  return { kind: "secret", namespaceId, id };
}

async function createNamespaceSecret(
  fixture,
  namespaceId,
  name,
  value = `${name}-${randomUUID()}`,
) {
  const created = await fixture.request("POST", `/namespaces/${namespaceId}/secrets`, {
    body: { name, value },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.data;
}

async function createProvisioningSecrets(fixture, namespaceId) {
  const modelKey = await createNamespaceSecret(fixture, namespaceId, "model-api-key");
  const slackBotToken = await createNamespaceSecret(fixture, namespaceId, "slack-bot-token");
  const slackSigningSecret = await createNamespaceSecret(
    fixture,
    namespaceId,
    "slack-signing-secret",
  );
  const externalServiceToken = await createNamespaceSecret(
    fixture,
    namespaceId,
    "external-service-token",
  );
  return { modelKey, slackBotToken, slackSigningSecret, externalServiceToken };
}

function provisioningBody(namespaceId, secrets, overrides = {}) {
  return {
    requestId: overrides.requestId ?? requestId(),
    name: overrides.name ?? `Provisioned ${randomUUID().slice(0, 8)}`,
    executionMode: "dedicated",
    configuration: {
      kind: "agent",
      values: {
        agents: { defaults: agentDefaults() },
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
          source: secretRef(namespaceId, secrets.slackBotToken.id),
          delivery: { type: "env" },
        },
        SLACK_SIGNING_SECRET: {
          source: secretRef(namespaceId, secrets.slackSigningSecret.id),
          delivery: { type: "env" },
        },
        EXTERNAL_SERVICE_TOKEN: {
          source: secretRef(namespaceId, secrets.externalServiceToken.id),
        },
      },
    },
    harnessAuth: {
      method: "api_key",
      source: secretRef(namespaceId, secrets.modelKey.id),
    },
    initialWorkspaceFiles: {
      "AGENTS.md": "Use the inline workspace setup from provisioning.",
    },
    ...overrides,
  };
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
  driver.inspectExact = async (configuration) => {
    try {
      const stored = await driver.read(configuration);
      assert.deepEqual(stored, configuration);
      return stored;
    } catch {
      return undefined;
    }
  };
  return driver;
}

async function privateBootstrapDirectory(context) {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-agent-provisioning-bootstrap-"));
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

function installationDrivers({ computeDriver, configurationDriver, secretDriver, repoDriver }) {
  return {
    installation: {
      occ: { cluster: "postgres-agent-provisioning" },
      logging: {},
      backend:
        repoDriver === undefined
          ? []
          : [
              {
                id: "provisioning-repositories",
                type: "github",
                configuration: { registryPath: "/unused/provisioning/registry.json" },
                drivers: { repo: repoDriver.id },
              },
            ],
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
    ...(repoDriver === undefined ? {} : { repoDriver }),
    createIAMDriver: (state) =>
      new NativeIAMDriver(state, { id: "native-iam", implementation: "native" }),
  };
}

async function createFixture(context, options = {}) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
  const state = new PostgresPlatformState(pool);
  await ensureProvisioningBootstrap(context, state);
  const credentials = { email: adminEmail, password: adminPassword };
  const computeDriver = options.computeDriver ?? createRuntimeComputeDriver();
  const configurationDriver =
    options.configurationDriver ??
    createProvisioningConfigurationDriver({ id: "configuration-provisioning" });
  const secretDriver =
    options.secretDriver ?? createTestSecretDriver({ id: "secret-provisioning" });
  let worker;
  let workerPool;
  let workerCompletion;
  const revokedBindings = [];
  const teardownCancellations = [];
  const drivers = installationDrivers({
    computeDriver,
    configurationDriver,
    secretDriver,
    repoDriver: options.repoDriver,
  });
  const app = await composePostgresDevelopment(
    {
      mode: "development",
      host: "127.0.0.1",
      databaseUrl,
      authSecret,
      authBaseURL,
    },
    drivers,
  );
  const session = await signInToControllerApp(app, credentials);

  context.after(async () => {
    for (const binding of revokedBindings) {
      await pool.query(
        `INSERT INTO occ.iam_access_bindings
         (id, namespace_id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [
          binding.id,
          binding.namespace_id,
          binding.identity_subject_id,
          binding.group_subject_id,
          binding.role_id,
          binding.resource_kind,
          binding.resource_id,
        ],
      );
    }
    for (const { namespaceId, agentId } of teardownCancellations) {
      await request("POST", `/namespaces/${namespaceId}/agents/${agentId}/stop`);
    }
    await stopWorker();
    await app.close?.();
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
    assert.equal(workerPool, undefined, "the fixture worker pool is already open");
    workerPool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
    worker = createControllerWorker({
      pool: workerPool,
      drivers,
      pollIntervalMs: 15,
      leaseDurationMs: 30_000,
      maxAttempts: 3,
      emit: (event) => {
        // This persistence case ends at durable handoff, before credential service dispatch.
        if (options.stopAfterProvisioning && event.code === "PROVISIONING_HANDED_OFF") {
          workerCompletion = worker.stop();
        }
      },
    });
    await worker.start();
  }

  async function stopWorker() {
    if (worker === undefined) {
      return;
    }
    const current = worker;
    worker = undefined;
    workerPool = undefined;
    await (workerCompletion ?? current.stop());
    workerCompletion = undefined;
  }

  async function revokeCurrentPrincipal() {
    const iam = await state.loadNativeIAMState();
    const principal = iam.identities.find(
      (identity) => identity.kind === "principal" && identity.issuer.endsWith(":better-auth"),
    );
    assert.ok(principal, "the bootstrapped administrator Principal must exist");
    const result = await pool.query(
      `DELETE FROM occ.iam_access_bindings
       WHERE identity_subject_id = $1
         AND namespace_id IS NULL
       RETURNING id, namespace_id, identity_subject_id, group_subject_id, role_id,
                 resource_kind, resource_id`,
      [principal.id],
    );
    assert.ok(result.rowCount > 0, "revocation must remove the exact administrator binding");
    revokedBindings.push(...result.rows);
  }

  function cancelProvisioningAtTeardown(namespaceId, agentId) {
    teardownCancellations.push({ namespaceId, agentId });
  }

  return {
    app,
    bootstrapNamespace,
    cancelProvisioningAtTeardown,
    computeDriver,
    pool,
    configurationDriver,
    revokeCurrentPrincipal,
    request,
    secretDriver,
    session,
    startWorker,
    state,
    stopWorker,
  };
}

async function provisioningRow(pool, namespaceId, requestId) {
  const result = await pool.query(
    "SELECT * FROM occ.agent_provisioning_work WHERE namespace_id = $1 AND request_id = $2",
    [namespaceId, requestId],
  );
  assert.equal(result.rowCount, 1, "provisioning admission must persist one request record");
  return result.rows[0];
}

async function claimProvisioningWork(pool, workId) {
  const claimToken = randomUUID();
  const claimed = await pool.query(
    `UPDATE occ.controller_work
     SET state = 'claimed',
         attempt_count = attempt_count + 1,
         claim_token = $2::uuid,
         lease_expires_at = clock_timestamp() + interval '10 minutes',
         updated_at = clock_timestamp()
     WHERE idempotency_key = $1
       AND work_kind = 'provisioning'
       AND state = 'queued'
     RETURNING idempotency_key`,
    [workId, claimToken],
  );
  assert.equal(claimed.rowCount, 1, "test must claim the exact queued provisioning work");
  return { idempotencyKey: workId, claimToken };
}

test(
  "provisioning API queues one job with existing Secret references and replays only the exact same request",
  requiresPostgres,
  async (context) => {
    const fixture = await createFixture(context);
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const body = provisioningBody(namespace.id, secrets);

    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    assert.deepEqual(Object.keys(admitted.data).sort(), ["provisioning"]);
    assert.match(admitted.data.provisioning.workId, /^agent-provisioning:/);
    assert.deepEqual(admitted.data.provisioning, {
      workId: admitted.data.provisioning.workId,
      status: "queued",
      phase: "admitted",
      attemptCount: 0,
      updatedAt: admitted.data.provisioning.updatedAt,
      url: `/namespaces/${namespace.id}/agents/provision/${encodeURIComponent(admitted.data.provisioning.workId)}`,
    });
    assert.equal(Number.isNaN(Date.parse(admitted.data.provisioning.updatedAt)), false);
    const status = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/agents/provision/${encodeURIComponent(admitted.data.provisioning.workId)}`,
    );
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.deepEqual(status.data, admitted.data.provisioning);
    assert.equal(JSON.stringify(admitted.body).includes("model-api-key"), false);
    const audit = await fixture.pool.query(
      `SELECT action, outcome, details
       FROM occ.audit_events
       WHERE namespace_id = $1
         AND resource_kind = 'agent'
         AND resource_id = $1
       ORDER BY occurred_at, id`,
      [namespace.id],
    );
    assert.ok(audit.rowCount > 0, "provisioning admission must append durable audit evidence");

    const row = await provisioningRow(fixture.pool, namespace.id, body.requestId);
    assert.equal(row.work_id, admitted.data.provisioning.workId);
    assert.equal(row.agent_id, null);
    assert.equal(row.configuration_id, null);
    assert.equal(row.status, "queued");
    assert.equal(row.completed_phase, "admitted");
    assert.equal(JSON.stringify(row).includes("model-api-key"), false);

    const resources = await fixture.pool.query(
      `SELECT
       (SELECT count(*)::integer FROM occ.agents WHERE namespace_id = $1) AS agents,
       (SELECT count(*)::integer FROM occ.configurations WHERE namespace_id = $1) AS configurations,
       (SELECT count(*)::integer FROM occ.secrets WHERE namespace_id = $1) AS secrets`,
      [namespace.id],
    );
    assert.deepEqual(resources.rows[0], {
      agents: 0,
      configurations: 0,
      secrets: 4,
    });

    const replay = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(replay.status, 202, JSON.stringify(replay.body));
    assert.equal(replay.data.provisioning.workId, admitted.data.provisioning.workId);

    const changed = structuredClone(body);
    changed.configuration.values = { ...changed.configuration.values, changed: randomUUID() };
    const rejected = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body: changed,
    });
    assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
    assert.equal(rejected.error.code, "RESOURCE_CONFLICT");

    const cleanupClaim = await claimProvisioningWork(
      fixture.pool,
      admitted.data.provisioning.workId,
    );
    const cancelled = await fixture.state.transact((unit) =>
      unit.provisioning.cancel(cleanupClaim, {
        code: "PROVISIONING_CANCELLED",
        message: "admission-only test completed without worker dispatch",
      }),
    );
    assert.equal(cancelled.status, "cancelled");
  },
);

test(
  "provisioning worker creates Configuration and Agent from existing Secrets, then hands off one revision",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const initial = await createFixture(context);
    const namespace = await initial.bootstrapNamespace();
    const repositoryBindings = [{ repositoryRef: "project", profile: "git-read" }];
    const repoDriver = new GitHubRepoDriver(
      {
        id: "provisioning-repositories",
        client: new UnixRepositoryCredentialControlClient({
          controlSocket: "/unused/provisioning/control.sock",
        }),
        drivers: { repo: "provisioning-repo" },
      },
      {
        version: 1,
        backendId: "provisioning-repositories",
        providerInstanceId: "provisioning-github",
        appId: "123",
        githubInstallationId: "456",
        maximumDurationSeconds: 3600,
        repositories: [
          {
            repositoryRef: "project",
            repositoryId: "789",
            repository: "example/project",
            namespaces: [{ namespaceId: namespace.id, profiles: ["git-read", "git-write"] }],
          },
        ],
      },
      { sessionDurationSeconds: 600 },
    );
    // Reuse the established runtime fixture, but exercise real repository policy and
    // Kubernetes topology admission without contacting either external system.
    const topology = createTestKubernetesComputeDriver("provisioning-topology", {
      repositoryCredentials: true,
    });
    const computeDriver = initial.computeDriver;
    computeDriver.validateRepositoryCredentials =
      topology.validateRepositoryCredentials.bind(topology);
    const fixture = await createFixture(context, {
      computeDriver,
      configurationDriver: initial.configurationDriver,
      secretDriver: initial.secretDriver,
      repoDriver,
      stopAfterProvisioning: true,
    });
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const secretCreateCallCount = fixture.secretDriver.calls.filter(
      ({ operation }) => operation === "create",
    ).length;
    const body = provisioningBody(namespace.id, secrets, { repositoryBindings });
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));

    const queued = await provisioningRow(fixture.pool, namespace.id, body.requestId);
    assert.deepEqual(queued.plan.repositoryBindings, repositoryBindings);
    assert.equal(queued.agent_id, null);
    const replay = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(replay.status, 202, JSON.stringify(replay.body));
    assert.equal(replay.data.provisioning.workId, admitted.data.provisioning.workId);
    const changed = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body: { ...body, repositoryBindings: [{ repositoryRef: "project", profile: "git-write" }] },
    });
    assert.equal(changed.status, 409, JSON.stringify(changed.body));

    await fixture.startWorker();
    const status = await waitFor("Agent provisioning to succeed", async () => {
      const observed = await fixture.request("GET", admitted.data.provisioning.url);
      assert.equal(observed.status, 200, JSON.stringify(observed.body));
      return observed.data.status === "succeeded" ? observed.data : undefined;
    });
    await fixture.stopWorker();
    assert.equal(status.status, "succeeded");
    assert.match(status.agentId, identifier("agt"));
    assert.match(status.configurationId, identifier("cfg"));

    assert.equal(
      fixture.secretDriver.calls.filter(({ operation }) => operation === "create").length,
      secretCreateCallCount,
      "provisioning must reuse Console-created Secrets instead of creating new Secret values",
    );

    const persistedSecrets = await fixture.pool.query(
      "SELECT id, name FROM occ.secrets WHERE namespace_id = $1 ORDER BY name",
      [namespace.id],
    );
    assert.deepEqual(
      persistedSecrets.rows.map(({ name }) => name),
      ["external-service-token", "model-api-key", "slack-bot-token", "slack-signing-secret"],
    );
    const grantRoleId = `role_${namespace.id}_agent_secret_operate`;
    const grantRole = await fixture.pool.query(
      "SELECT permissions FROM occ.iam_roles WHERE namespace_id = $1 AND id = $2",
      [namespace.id, grantRoleId],
    );
    assert.equal(grantRole.rowCount, 1);
    assert.deepEqual(grantRole.rows[0].permissions, [
      { action: "operate", resourceKind: "secret" },
    ]);
    const grants = await fixture.pool.query(
      `SELECT binding.resource_id
       FROM occ.iam_access_bindings AS binding
       JOIN occ.agents AS agent
         ON agent.namespace_id = binding.namespace_id
        AND agent.service_principal_id = binding.identity_subject_id
       WHERE binding.namespace_id = $1
         AND agent.id = $2
         AND binding.role_id = $3
         AND binding.resource_kind = 'secret'
       ORDER BY binding.resource_id`,
      [namespace.id, status.agentId, grantRoleId],
    );
    assert.deepEqual(
      grants.rows.map(({ resource_id: resourceId }) => resourceId),
      persistedSecrets.rows.map(({ id }) => id).sort(),
      "provisioning must grant the Agent service principal exact operate access to each referenced Secret",
    );
    const configuration = await fixture.pool.query(
      "SELECT generation, secret_bindings FROM occ.configurations WHERE namespace_id = $1 AND id = $2",
      [namespace.id, status.configurationId],
    );
    assert.equal(configuration.rowCount, 1);
    assert.equal(Number(configuration.rows[0].generation), 1);
    assert.deepEqual(Object.keys(configuration.rows[0].secret_bindings).sort(), [
      "EXTERNAL_SERVICE_TOKEN",
      "SLACK_BOT_TOKEN",
      "SLACK_SIGNING_SECRET",
    ]);
    const revisions = await fixture.state.read((view) =>
      view.revisions.listRevisions(namespace.id, status.agentId),
    );
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].id, status.revisionId);
    assert.equal(revisions[0].configurationGeneration, 1);
    const agentPath = `/namespaces/${namespace.id}/agents/${status.agentId}`;
    const agent = await fixture.request("GET", agentPath);
    assert.equal(agent.status, 200, JSON.stringify(agent.body));
    assert.deepEqual(agent.data.repositoryBindings, repositoryBindings);
    const revisionPath = `${agentPath}/revisions/${status.revisionId}`;
    const revision = await fixture.request("GET", revisionPath);
    assert.equal(revision.status, 200, JSON.stringify(revision.body));
    assert.deepEqual(revision.data.repositoryCredentials.bindings, repositoryBindings);
    assert.equal(revisions[0].repositoryCredentials.bindings[0].grant.repositoryId, "789");
    const cleared = await fixture.request("PATCH", agentPath, {
      body: { configurationId: status.configurationId, repositoryBindings: [] },
    });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(Object.hasOwn(cleared.data, "repositoryBindings"), false);
    const historical = await fixture.request("GET", revisionPath);
    assert.equal(historical.status, 200, JSON.stringify(historical.body));
    assert.deepEqual(historical.data.repositoryCredentials, revision.data.repositoryCredentials);
    assert.equal(revisions[0].harnessAuth.method, "api_key");
    assert.deepEqual(
      fixture.computeDriver.calls
        .filter(({ operation }) => operation === "provisionAgentRuntimeCredentials")
        .map(({ agentId }) => agentId),
      [status.agentId],
    );

    const work = await fixture.pool.query(
      "SELECT state FROM occ.controller_work WHERE work_kind = 'provisioning' AND namespace_id = $1 AND idempotency_key = $2",
      [namespace.id, admitted.data.provisioning.workId],
    );
    assert.equal(work.rowCount, 1);
    assert.equal(work.rows[0].state, "succeeded");
  },
);

for (const authMethod of ["api_key", "codex_pat"]) {
  test(
    `${authMethod} provisioning grants existing Secret access and hands off one revision`,
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const fixture = await createFixture(context);
      const namespace = await fixture.bootstrapNamespace();
      const secrets = await createProvisioningSecrets(fixture, namespace.id);
      const secretCreateCallCount = fixture.secretDriver.calls.filter(
        ({ operation }) => operation === "create",
      ).length;
      const body = provisioningBody(namespace.id, secrets, {
        harnessAuth: { method: authMethod, source: secretRef(namespace.id, secrets.modelKey.id) },
      });
      // Model-only references must obey the same Namespace boundary as channel Secrets.
      const foreign = structuredClone(body);
      foreign.harnessAuth.source.namespaceId = `ns_${randomUUID()}`;
      const denied = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
        body: foreign,
      });
      assert.equal(denied.status, 404, JSON.stringify(denied.body));
      const jobs = await fixture.pool.query(
        "SELECT work_id FROM occ.agent_provisioning_work WHERE namespace_id = $1",
        [namespace.id],
      );
      assert.equal(jobs.rowCount, 0, "foreign model references must not admit provisioning work");
      const admitted = await fixture.request(
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        {
          body,
        },
      );
      assert.equal(admitted.status, 202, JSON.stringify(admitted.body));

      await fixture.startWorker();
      const status = await waitFor("Agent provisioning to succeed", async () => {
        const observed = await fixture.request("GET", admitted.data.provisioning.url);
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        return observed.data.status === "succeeded" ? observed.data : undefined;
      });
      assert.equal(status.status, "succeeded");
      assert.match(status.agentId, identifier("agt"));
      assert.match(status.configurationId, identifier("cfg"));
      fixture.cancelProvisioningAtTeardown(namespace.id, status.agentId);
      assert.equal(
        fixture.secretDriver.calls.filter(({ operation }) => operation === "create").length,
        secretCreateCallCount,
        "provisioning must reuse Console-created Secrets instead of creating new Secret values",
      );

      const persistedSecrets = await fixture.pool.query(
        "SELECT id, name FROM occ.secrets WHERE namespace_id = $1 ORDER BY name",
        [namespace.id],
      );
      assert.deepEqual(
        persistedSecrets.rows.map(({ name }) => name),
        ["external-service-token", "model-api-key", "slack-bot-token", "slack-signing-secret"],
      );
      const grantRoleId = `role_${namespace.id}_agent_secret_operate`;
      const grantRole = await fixture.pool.query(
        "SELECT permissions FROM occ.iam_roles WHERE namespace_id = $1 AND id = $2",
        [namespace.id, grantRoleId],
      );
      assert.equal(grantRole.rowCount, 1);
      assert.deepEqual(grantRole.rows[0].permissions, [
        { action: "operate", resourceKind: "secret" },
      ]);
      const grants = await fixture.pool.query(
        `SELECT binding.resource_id
       FROM occ.iam_access_bindings AS binding
       JOIN occ.agents AS agent
         ON agent.namespace_id = binding.namespace_id
        AND agent.service_principal_id = binding.identity_subject_id
       WHERE binding.namespace_id = $1
         AND agent.id = $2
         AND binding.role_id = $3
         AND binding.resource_kind = 'secret'
       ORDER BY binding.resource_id`,
        [namespace.id, status.agentId, grantRoleId],
      );
      assert.deepEqual(
        grants.rows.map(({ resource_id: resourceId }) => resourceId),
        persistedSecrets.rows.map(({ id }) => id).sort(),
        "provisioning must grant the Agent service principal exact operate access to each referenced Secret",
      );
      const configuration = await fixture.pool.query(
        "SELECT generation, secret_bindings FROM occ.configurations WHERE namespace_id = $1 AND id = $2",
        [namespace.id, status.configurationId],
      );
      assert.equal(configuration.rowCount, 1);
      assert.equal(Number(configuration.rows[0].generation), 1);
      assert.deepEqual(Object.keys(configuration.rows[0].secret_bindings).sort(), [
        "EXTERNAL_SERVICE_TOKEN",
        "SLACK_BOT_TOKEN",
        "SLACK_SIGNING_SECRET",
      ]);
      const revisions = await fixture.state.read((view) =>
        view.revisions.listRevisions(namespace.id, status.agentId),
      );
      assert.equal(revisions.length, 1);
      assert.equal(revisions[0].id, status.revisionId);
      assert.equal(revisions[0].configurationGeneration, 1);
      assert.equal(revisions[0].harnessAuth.method, authMethod);
      assert.deepEqual(revisions[0].harnessAuth.source, body.harnessAuth.source);
      assert.deepEqual(
        fixture.computeDriver.calls
          .filter(({ operation }) => operation === "provisionAgentRuntimeCredentials")
          .map(({ agentId }) => agentId),
        [status.agentId],
      );

      const work = await fixture.pool.query(
        "SELECT state FROM occ.controller_work WHERE work_kind = 'provisioning' AND namespace_id = $1 AND idempotency_key = $2",
        [namespace.id, admitted.data.provisioning.workId],
      );
      assert.equal(work.rowCount, 1);
      assert.equal(work.rows[0].state, "succeeded");
    },
  );
}

test(
  "queued provisioning leaves existing Secrets but creates no Agent or Configuration before a worker runs",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const secretDriver = createTestSecretDriver({ id: "secret-provisioning-cancel" });
    const fixture = await createFixture(context, { secretDriver });
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const body = provisioningBody(namespace.id, secrets);
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    assert.deepEqual(
      secretDriver.calls.map(({ operation }) => operation),
      ["create", "create", "create", "create"],
      "only the explicit Secret API calls should touch the Secret backend before provisioning runs",
    );
    const resources = await fixture.pool.query(
      `SELECT
       (SELECT count(*)::integer FROM occ.agents WHERE namespace_id = $1) AS agents,
       (SELECT count(*)::integer FROM occ.configurations WHERE namespace_id = $1) AS configurations,
       (SELECT count(*)::integer FROM occ.agent_revisions WHERE namespace_id = $1) AS revisions,
       (SELECT count(*)::integer FROM occ.secrets WHERE namespace_id = $1) AS secrets`,
      [namespace.id],
    );
    assert.deepEqual(resources.rows[0], {
      agents: 0,
      configurations: 0,
      revisions: 0,
      secrets: 4,
    });
    const status = await fixture.request("GET", admitted.data.provisioning.url);
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(status.data.status, "queued");
    assert.equal(status.data.agentId, undefined);
    assert.equal(status.data.configurationId, undefined);
    const work = await fixture.pool.query(
      "SELECT state FROM occ.controller_work WHERE work_kind = 'provisioning' AND namespace_id = $1 AND idempotency_key = $2",
      [namespace.id, admitted.data.provisioning.workId],
    );
    assert.deepEqual(work.rows, [{ state: "queued" }]);
  },
);

test(
  "provisioning worker reauthorizes after admission and revoked authority creates no backend effects",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const secretDriver = createTestSecretDriver({ id: "secret-provisioning-revoked" });
    const fixture = await createFixture(context, { secretDriver });
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const body = provisioningBody(namespace.id, secrets);
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));

    await fixture.revokeCurrentPrincipal();
    await fixture.startWorker();
    const work = await waitFor("provisioning work to fail after authority revocation", async () => {
      const observed = await fixture.pool.query(
        "SELECT state, reason_code FROM occ.controller_work WHERE work_kind = 'provisioning' AND namespace_id = $1 AND idempotency_key = $2",
        [namespace.id, admitted.data.provisioning.workId],
      );
      assert.equal(observed.rowCount, 1);
      return observed.rows[0].state === "failed_permanent" ? observed.rows[0] : undefined;
    });
    assert.equal(work.reason_code, "PROVISIONING_REJECTED");
    const denialAudit = await fixture.pool.query(
      `SELECT kind, outcome, details->'__occAuditMetadata'->>'reasonCode' AS reason_code
       FROM occ.audit_events
       WHERE namespace_id = $1
         AND resource_kind = 'agent'
         AND resource_id = $2
         AND action = 'openclaw.agents.provision.failure'
         AND kind = 'authorization_denial'`,
      [namespace.id, admitted.data.provisioning.workId],
    );
    assert.deepEqual(denialAudit.rows, [
      {
        kind: "authorization_denial",
        outcome: "denied",
        reason_code: "AUTHORIZATION_DENIED",
      },
    ]);
    assert.deepEqual(
      secretDriver.calls.map(({ operation }) => operation),
      ["create", "create", "create", "create"],
      "revoked initiating authority must not create additional Secret backend values",
    );
    const resources = await fixture.pool.query(
      `SELECT
       (SELECT count(*)::integer FROM occ.agents WHERE namespace_id = $1) AS agents,
       (SELECT count(*)::integer FROM occ.configurations WHERE namespace_id = $1) AS configurations,
       (SELECT count(*)::integer FROM occ.agent_revisions WHERE namespace_id = $1) AS revisions,
       (SELECT count(*)::integer FROM occ.secrets WHERE namespace_id = $1) AS secrets`,
      [namespace.id],
    );
    assert.deepEqual(resources.rows[0], {
      agents: 0,
      configurations: 0,
      revisions: 0,
      secrets: 4,
    });
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
    const inspectExact = configurationDriver.inspectExact;
    let loseConfigurationReceipt = true;
    let allowConfigurationRecovery = false;
    configurationDriver.createExact = async (configuration) => {
      const created = await createExact(configuration);
      if (loseConfigurationReceipt) {
        loseConfigurationReceipt = false;
        throw new Error("synthetic Configuration receipt loss");
      }
      return created;
    };
    configurationDriver.inspectExact = (configuration) =>
      allowConfigurationRecovery ? inspectExact(configuration) : undefined;
    const fixture = await createFixture(context, { computeDriver, configurationDriver });
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const body = provisioningBody(namespace.id, secrets);
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));

    await fixture.startWorker();
    const failed = await waitFor(
      "Agent provisioning to fail after losing the Configuration receipt",
      async () => {
        const observed = await fixture.request("GET", admitted.data.provisioning.url);
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        return observed.data.status === "failed" ? observed.data : undefined;
      },
    );
    assert.equal(failed.phase, "admitted");
    assert.equal(failed.error?.code, "PROVISIONING_OUTCOME_UNKNOWN");
    assert.deepEqual(
      computeDriver.calls.map(({ operation }) => operation),
      [],
      "a pre-dispatch Configuration dependency failure must not reach transport effects",
    );
    const failedResources = await fixture.pool.query(
      `SELECT
       (SELECT count(*)::integer FROM occ.agents WHERE namespace_id = $1) AS agents,
       (SELECT count(*)::integer FROM occ.configurations WHERE namespace_id = $1) AS configurations,
       (SELECT count(*)::integer FROM occ.agent_revisions WHERE namespace_id = $1) AS revisions`,
      [namespace.id],
    );
    assert.deepEqual(
      failedResources.rows[0],
      { agents: 0, configurations: 0, revisions: 0 },
      "Configuration backend creation must finish before the workflow creates an Agent",
    );
    await fixture.stopWorker();

    allowConfigurationRecovery = true;
    const retried = await fixture.request("POST", `${admitted.data.provisioning.url}/retry`);
    assert.equal(retried.status, 202, JSON.stringify(retried.body));
    assert.equal(retried.data.status, "queued");
    assert.equal(retried.data.phase, "admitted");

    await fixture.startWorker();
    const succeeded = await waitFor("retried Agent provisioning to succeed", async () => {
      const observed = await fixture.request("GET", admitted.data.provisioning.url);
      assert.equal(observed.status, 200, JSON.stringify(observed.body));
      return observed.data.status === "succeeded" ? observed.data : undefined;
    });
    assert.equal(succeeded.revisionId?.startsWith("rev_"), true);
    assert.match(succeeded.agentId, identifier("agt"));
    fixture.cancelProvisioningAtTeardown(namespace.id, succeeded.agentId);

    const agents = await fixture.pool.query("SELECT id FROM occ.agents WHERE namespace_id = $1", [
      namespace.id,
    ]);
    assert.deepEqual(
      agents.rows.map(({ id }) => id),
      [succeeded.agentId],
      "retry must resume the accepted provisioning plan instead of creating a replacement Agent",
    );
    const revisions = await fixture.pool.query(
      "SELECT id FROM occ.agent_revisions WHERE namespace_id = $1 AND agent_id = $2",
      [namespace.id, succeeded.agentId],
    );
    assert.equal(revisions.rowCount, 1);
    assert.deepEqual(
      computeDriver.calls
        .filter(({ operation }) => operation === "provisionAgentRuntimeCredentials")
        .map(({ agentId }) => agentId),
      [succeeded.agentId],
    );
  },
);

test(
  "Stop and Delete cancel failed pre-handoff provisioning Agents without deployment resurrection",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    async function createFailedPreHandoffAgent(fixture) {
      const namespace = await fixture.bootstrapNamespace();
      const secrets = await createProvisioningSecrets(fixture, namespace.id);
      const body = provisioningBody(namespace.id, secrets);
      const admitted = await fixture.request(
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        {
          body,
        },
      );
      assert.equal(admitted.status, 202, JSON.stringify(admitted.body));

      await fixture.startWorker();
      const failed = await waitFor("Agent provisioning to fail before handoff", async () => {
        const observed = await fixture.request("GET", admitted.data.provisioning.url);
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        return observed.data.status === "failed" ? observed.data : undefined;
      });
      await fixture.stopWorker();
      assert.match(failed.agentId, identifier("agt"));
      assert.equal(failed.revisionId, undefined);
      const pending = await fixture.pool.query(
        "SELECT progress->'pendingEffect' AS pending_effect FROM occ.agent_provisioning_work WHERE work_id = $1",
        [admitted.data.provisioning.workId],
      );
      assert.equal(pending.rowCount, 1);
      assert.deepEqual(pending.rows[0].pending_effect?.kind, "transport");
      assert.deepEqual(pending.rows[0].pending_effect?.targetId, failed.agentId);
      return { namespace, admitted, failed, pendingEffect: pending.rows[0].pending_effect };
    }

    function failingTransportDriver() {
      const computeDriver = createRuntimeComputeDriver();
      const provisionRuntimeCredentials = computeDriver.provisionAgentRuntimeCredentials;
      computeDriver.provisionAgentRuntimeCredentials = async (...args) => {
        await provisionRuntimeCredentials(...args);
        throw new Error("synthetic pre-handoff transport failure");
      };
      computeDriver.getAgentRuntimeCredentialStatus = async () => ({ transportConfigured: false });
      return computeDriver;
    }

    async function settleLateTransport(fixture, target) {
      const settled = await fixture.state.transact((unit) =>
        unit.provisioning.settleEffect(target.admitted.data.provisioning.workId, {
          kind: "transport",
          owner: target.pendingEffect.owner,
          targetId: target.pendingEffect.targetId,
          result: { status: { transportConfigured: true } },
        }),
      );
      assert.equal(settled.status, "cancelled");
      const revisions = await fixture.pool.query(
        "SELECT id FROM occ.agent_revisions WHERE namespace_id = $1 AND agent_id = $2",
        [target.namespace.id, target.failed.agentId],
      );
      assert.equal(revisions.rowCount, 0, "late settlement must not deploy by itself");
      return settled;
    }

    const stopFixture = await createFixture(context, { computeDriver: failingTransportDriver() });
    const stopTarget = await createFailedPreHandoffAgent(stopFixture);
    const stopped = await stopFixture.request(
      "POST",
      `/namespaces/${stopTarget.namespace.id}/agents/${stopTarget.failed.agentId}/stop`,
    );
    assert.equal(stopped.status, 202, JSON.stringify(stopped.body));
    assert.equal(stopped.data.desiredRuntimeState, "stopped");
    const stoppedProvisioning = await stopFixture.request(
      "GET",
      stopTarget.admitted.data.provisioning.url,
    );
    assert.equal(stoppedProvisioning.status, 200, JSON.stringify(stoppedProvisioning.body));
    assert.equal(stoppedProvisioning.data.status, "failed");
    assert.equal(stoppedProvisioning.data.error?.code, "PROVISIONING_CANCELLED");

    await settleLateTransport(stopFixture, stopTarget);
    const deployed = await stopFixture.request(
      "POST",
      `/namespaces/${stopTarget.namespace.id}/agents/${stopTarget.failed.agentId}/deploy`,
    );
    assert.equal(deployed.status, 202, JSON.stringify(deployed.body));
    assert.equal(deployed.data.id?.startsWith("rev_"), true);
    stopFixture.cancelProvisioningAtTeardown(stopTarget.namespace.id, stopTarget.failed.agentId);

    const deleteFixture = await createFixture(context, { computeDriver: failingTransportDriver() });
    const deleteTarget = await createFailedPreHandoffAgent(deleteFixture);
    const deleting = await deleteFixture.request(
      "DELETE",
      `/namespaces/${deleteTarget.namespace.id}/agents/${deleteTarget.failed.agentId}`,
    );
    assert.equal(deleting.status, 202, JSON.stringify(deleting.body));
    assert.equal(deleting.data.status, "deleting");
    const deletedProvisioning = await deleteFixture.request(
      "GET",
      deleteTarget.admitted.data.provisioning.url,
    );
    assert.equal(deletedProvisioning.status, 200, JSON.stringify(deletedProvisioning.body));
    assert.equal(deletedProvisioning.data.status, "failed");
    assert.equal(deletedProvisioning.data.error?.code, "PROVISIONING_CANCELLED");

    await settleLateTransport(deleteFixture, deleteTarget);
    const deletedAgent = await deleteFixture.request(
      "GET",
      `/namespaces/${deleteTarget.namespace.id}/agents/${deleteTarget.failed.agentId}`,
    );
    assert.equal(deletedAgent.status, 200, JSON.stringify(deletedAgent.body));
    assert.equal(deletedAgent.data.status, "deleting");
    const blockedDeploy = await deleteFixture.request(
      "POST",
      `/namespaces/${deleteTarget.namespace.id}/agents/${deleteTarget.failed.agentId}/deploy`,
    );
    assert.equal(blockedDeploy.status, 409, JSON.stringify(blockedDeploy.body));
  },
);

test(
  "failed provisioning keeps the accepted plan reserved until retry or deletion",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const computeDriver = createRuntimeComputeDriver();
    const provisionRuntimeCredentials = computeDriver.provisionAgentRuntimeCredentials;
    const getRuntimeCredentialStatus = computeDriver.getAgentRuntimeCredentialStatus;
    let failTransportSettlement = true;
    let reportTransportConfigured = false;
    computeDriver.provisionAgentRuntimeCredentials = async (...args) => {
      const status = await provisionRuntimeCredentials(...args);
      if (failTransportSettlement) {
        throw new Error("synthetic transport settlement failure");
      }
      return status;
    };
    computeDriver.getAgentRuntimeCredentialStatus = async (...args) =>
      reportTransportConfigured
        ? getRuntimeCredentialStatus(...args)
        : { transportConfigured: false };
    const fixture = await createFixture(context, { computeDriver });
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const body = provisioningBody(namespace.id, secrets);
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));

    await fixture.startWorker();
    const failed = await waitFor("Agent provisioning to fail after transport effect", async () => {
      const observed = await fixture.request("GET", admitted.data.provisioning.url);
      assert.equal(observed.status, 200, JSON.stringify(observed.body));
      return observed.data.status === "failed" ? observed.data : undefined;
    });
    assert.equal(failed.phase, "configuration");
    assert.equal(failed.error?.code, "PROVISIONING_OUTCOME_UNKNOWN");
    assert.match(failed.agentId, identifier("agt"));
    assert.match(failed.configurationId, identifier("cfg"));
    fixture.cancelProvisioningAtTeardown(namespace.id, failed.agentId);
    await fixture.stopWorker();

    const configuration = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${failed.configurationId}`,
    );
    assert.equal(configuration.status, 200, JSON.stringify(configuration.body));

    const reserved = [
      await fixture.request(
        "POST",
        `/namespaces/${namespace.id}/agents/${failed.agentId}/runtime-credentials`,
        { body: {} },
      ),
      await fixture.request("POST", `/namespaces/${namespace.id}/agents/${failed.agentId}/deploy`),
      await fixture.request("PATCH", `/namespaces/${namespace.id}/agents/${failed.agentId}`, {
        body: { configurationId: failed.configurationId },
      }),
      await fixture.request(
        "PATCH",
        `/namespaces/${namespace.id}/configurations/${failed.configurationId}`,
        {
          body: {
            values: configuration.data.values,
            secretBindings: configuration.data.secretBindings,
          },
        },
      ),
    ];
    assert.deepEqual(
      reserved.map(({ status }) => status),
      [409, 409, 409, 409],
      "failed pre-handoff provisioning must reserve direct credential, deploy, Agent, and Configuration mutations",
    );

    failTransportSettlement = false;
    reportTransportConfigured = true;
    const retried = await fixture.request("POST", `${admitted.data.provisioning.url}/retry`);
    assert.equal(retried.status, 202, JSON.stringify(retried.body));
    assert.equal(retried.data.status, "queued");
    assert.equal(retried.data.error, undefined);

    await fixture.startWorker();
    const succeeded = await waitFor(
      "transport-recovered Agent provisioning to succeed",
      async () => {
        const observed = await fixture.request("GET", admitted.data.provisioning.url);
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        return observed.data.status === "succeeded" ? observed.data : undefined;
      },
    );
    assert.equal(succeeded.revisionId?.startsWith("rev_"), true);

    const revisions = await fixture.pool.query(
      "SELECT id FROM occ.agent_revisions WHERE namespace_id = $1 AND agent_id = $2",
      [namespace.id, failed.agentId],
    );
    assert.equal(revisions.rowCount, 1);
  },
);
