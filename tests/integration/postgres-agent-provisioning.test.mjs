import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  ConfigurationHarnessError,
  NativeWorkerSupportError,
  PostgresPlatformState,
} from "../../packages/occ/src/index.ts";
import { composePostgresDevelopment } from "../../apps/controller/src/composition/development-postgres.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import { GitHubRepoDriver } from "../../apps/controller/src/drivers/repo/github/driver.ts";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.mjs";
import {
  ensureDevelopmentBootstrap,
  privateBootstrapDirectory,
} from "../helpers/bootstrap-installation.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

const adminEmail = "postgres-agent-provisioning-v2@example.test";
const adminPassword = "postgres-agent-provisioning-password";
const authBaseURL = "http://127.0.0.1";
const authSecret = "postgres-agent-provisioning-auth-secret-32-bytes";
let bootstrapPromise;
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
  const slackBotToken = await createNamespaceSecret(
    fixture,
    namespaceId,
    "slack-bot-token",
    `xoxb-${randomUUID()}`,
  );
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
            mode: "http",
            botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
            signingSecret: { source: "env", provider: "default", id: "SLACK_SIGNING_SECRET" },
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
    requiresAgentRuntimeCredentials: true,
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
    async deleteAgentRuntimeCredentials(binding) {
      calls.push({ operation: "deleteAgentRuntimeCredentials", agentId: binding.agent.id });
      runtimeStatus.delete(keyOf(binding));
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

async function ensureProvisioningBootstrap(context, state) {
  if ((await state.loadInstallation()) !== undefined) {
    return;
  }
  bootstrapPromise ??= (async () => {
    await ensureDevelopmentBootstrap(context, {
      databaseUrl,
      directory: await privateBootstrapDirectory(context, "openclaw-agent-provisioning-bootstrap-"),
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

function installationDrivers({
  computeDriver,
  configurationDriver,
  secretDriver,
  repoDriver,
  pluginDriver,
  sandboxDriver,
  nativeWorkerSupport,
}) {
  return {
    installation: {
      occ: { cluster: "postgres-agent-provisioning" },
      logging: {},
      ...(nativeWorkerSupport === undefined ? {} : { runtime: { nativeWorkerSupport } }),
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
        ...(sandboxDriver === undefined
          ? {}
          : {
              sandbox: {
                id: sandboxDriver.id,
                implementation: sandboxDriver.implementation,
                configuration: {},
              },
            }),
      },
    },
    computeDriver,
    configurationDriver,
    secretDriver,
    ...(sandboxDriver === undefined ? {} : { sandboxDriver }),
    ...(repoDriver === undefined ? {} : { repoDriver }),
    ...(pluginDriver === undefined ? {} : { pluginDriver }),
    createIAMDriver: (state) =>
      new NativeIAMDriver(state, { id: "native-iam", implementation: "native" }),
  };
}

async function createFixture(context, options = {}) {
  // Keep real admission and Secret access; only Slack's external response is a fixture.
  const originalFetch = globalThis.fetch;
  context.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url) === "https://slack.com/api/auth.test") {
      assert.match(init.headers.authorization, /^Bearer xoxb-/);
      return Response.json({ ok: true, bot_id: "B0123456789", team_id: "T0123456789" });
    }
    return originalFetch(url, init);
  });
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
    pluginDriver: options.pluginDriver,
    sandboxDriver: options.sandboxDriver,
    nativeWorkerSupport: options.nativeWorkerSupport,
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
      leaseDurationMs: options.leaseDurationMs ?? 30_000,
      maxAttempts: 3,
      emit: (event) => {
        options.onWorkerEvent?.(event);
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

  // The signed-in administrator's Principal, whose subject is its account: a test may add
  // other administrators, so the first better-auth Principal is not necessarily this one.
  async function administratorPrincipalId() {
    const current = await request("GET", "/api/auth/session");
    assert.equal(current.status, 200, JSON.stringify(current.body));
    const iam = await state.loadNativeIAMState();
    const principals = iam.identities.filter(
      (identity) =>
        identity.kind === "principal" &&
        identity.issuer.endsWith(":better-auth") &&
        identity.subject === current.data.user.id,
    );
    assert.equal(principals.length, 1, "exactly one Principal must match the signed-in account");
    return principals[0].id;
  }

  async function revokeCurrentPrincipal() {
    const principalId = await administratorPrincipalId();
    const result = await pool.query(
      `DELETE FROM occ.iam_access_bindings
       WHERE identity_subject_id = $1
         AND namespace_id IS NULL
       RETURNING id, namespace_id, identity_subject_id, group_subject_id, role_id,
                 resource_kind, resource_id`,
      [principalId],
    );
    assert.ok(result.rowCount > 0, "revocation must remove the exact administrator binding");
    revokedBindings.push(...result.rows);
    return principalId;
  }

  function cancelProvisioningAtTeardown(namespaceId, agentId) {
    teardownCancellations.push({ namespaceId, agentId });
  }

  return {
    administratorPrincipalId,
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

async function assertProvisionedSecretAccess(fixture, namespace, status, secretCreateCallCount) {
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
  assert.deepEqual(grantRole.rows[0].permissions, [{ action: "operate", resourceKind: "secret" }]);
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
    // The HTTP request is audited too, keyed by the accepted work item.
    const requestAudit = await fixture.pool.query(
      `SELECT action, outcome
       FROM occ.audit_events
       WHERE namespace_id = $1 AND resource_kind = 'agent' AND resource_id = $2`,
      [namespace.id, admitted.data.provisioning.workId],
    );
    assert.deepEqual(requestAudit.rows, [
      { action: "openclaw.agents.provision", outcome: "success" },
    ]);

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
    const repositoryAccess = {
      defaultProfile: "git-read",
      repositories: [{ repositoryRef: "project" }],
    };
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
    const body = {
      ...provisioningBody(namespace.id, secrets, { repositoryAccess }),
      pluginApprovers: [],
    };
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));

    const queued = await provisioningRow(fixture.pool, namespace.id, body.requestId);
    assert.deepEqual(queued.plan.repositoryBindings, repositoryBindings);
    assert.deepEqual(queued.plan.repositoryAccess, repositoryAccess);
    assert.deepEqual(queued.plan.pluginApprovers, []);
    assert.equal(queued.agent_id, null);
    const replay = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(replay.status, 202, JSON.stringify(replay.body));
    assert.equal(replay.data.provisioning.workId, admitted.data.provisioning.workId);
    const changed = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body: { ...body, repositoryAccess: { ...repositoryAccess, defaultProfile: "git-write" } },
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

    await assertProvisionedSecretAccess(fixture, namespace, status, secretCreateCallCount);
    const revisions = await fixture.state.read((view) =>
      view.revisions.listRevisions(namespace.id, status.agentId),
    );
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].id, status.revisionId);
    assert.equal(revisions[0].configurationGeneration, 1);
    assert.deepEqual(revisions[0].pluginApprovers, []);
    const agentPath = `/namespaces/${namespace.id}/agents/${status.agentId}`;
    const agent = await fixture.request("GET", agentPath);
    assert.equal(agent.status, 200, JSON.stringify(agent.body));
    assert.deepEqual(agent.data.repositoryBindings, repositoryBindings);
    assert.deepEqual(agent.data.repositoryAccess, repositoryAccess);
    assert.deepEqual(agent.data.pluginApprovers, []);
    const revisionPath = `${agentPath}/revisions/${status.revisionId}`;
    const revision = await fixture.request("GET", revisionPath);
    assert.equal(revision.status, 200, JSON.stringify(revision.body));
    assert.deepEqual(revision.data.repositoryCredentials.bindings, repositoryBindings);
    assert.equal(revisions[0].repositoryCredentials.bindings[0].grant.repositoryId, "789");
    // Persist explicit intent even when equal to the default, then change only that default.
    const custom = { defaultProfile: "git-write", repositories: repositoryBindings };
    const customized = await fixture.request("PATCH", agentPath, {
      body: { configurationId: status.configurationId, repositoryAccess: custom },
    });
    assert.equal(customized.status, 200, JSON.stringify(customized.body));
    assert.deepEqual((await fixture.request("GET", agentPath)).data.repositoryAccess, custom);
    assert.deepEqual(customized.data.repositoryBindings, repositoryBindings);
    // Database constraints enforce consistency even when an application writer is bypassed.
    for (const invalid of [
      { defaultProfile: "git-write", repositories: [{ repositoryRef: "project" }] },
      { ...custom, extra: true },
      { ...custom, repositories: [...repositoryBindings, ...repositoryBindings] },
      { ...custom, repositories: [{ repositoryRef: "project", profile: null }] },
    ]) {
      await assert.rejects(
        fixture.pool.query(
          "UPDATE occ.agents SET repository_access = $1::jsonb WHERE namespace_id = $2 AND id = $3",
          [JSON.stringify(invalid), namespace.id, status.agentId],
        ),
        { code: "23514" },
      );
    }
    const cleared = await fixture.request("PATCH", agentPath, {
      body: { configurationId: status.configurationId, repositoryBindings: [] },
    });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(Object.hasOwn(cleared.data, "repositoryBindings"), false);
    assert.equal(Object.hasOwn(cleared.data, "repositoryAccess"), false);
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
      assert.equal(denied.status, 400, JSON.stringify(denied.body));
      assert.equal(denied.body.error.code, "INVALID_REQUEST");
      assert.equal(denied.body.error.message, "Secret references cannot cross Namespaces.");
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
      await assertProvisionedSecretAccess(fixture, namespace, status, secretCreateCallCount);
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
      ["create", "create", "create", "create", "withValue"],
      "admission validates the existing Slack Secret without creating provisioning resources",
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
  "provisioning status never pairs a job with a queue row from a later commit",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const fixture = await createFixture(context);
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body: provisioningBody(namespace.id, secrets),
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    const { workId, url } = admitted.data.provisioning;
    const claim = await claimProvisioningWork(fixture.pool, workId);
    const failure = {
      code: "PROVISIONING_REJECTED",
      message: "Agent provisioning could not complete.",
    };

    // Stage the worker's permanent failure the way the worker writes it (job and queue row in
    // one transaction) and hold its commit open.
    let releaseCommit;
    const commitGate = new Promise((resolve) => {
      releaseCommit = resolve;
    });
    let staged;
    const failureStaged = new Promise((resolve) => {
      staged = resolve;
    });
    const committed = fixture.state.transact(async (unit) => {
      const current = await unit.provisioning.findByWorkId(workId);
      await unit.provisioning.recordFailure(
        claim,
        {
          completedPhase: current.completedPhase,
          progress: { ...current.progress, error: failure },
        },
        { disposition: "permanent", ...failure },
      );
      staged();
      await commitGate;
    });
    await failureStaged;

    // Commit the failure right after the status read's first statement on this job returns.
    // The hook only delays that result; the controller's own queries produce the response.
    // Reading the job and queue row in separate statements would now see a failed queue row
    // next to the pre-failure job and report a generic failure.
    let interleaved = false;
    const query = pg.Client.prototype.query;
    const hook = context.mock.method(
      pg.Client.prototype,
      "query",
      function (config, values, callback) {
        const result = query.call(this, config, values, callback);
        if (
          !interleaved &&
          typeof config === "string" &&
          config.includes("occ.agent_provisioning_work") &&
          Array.isArray(values) &&
          values[0] === workId &&
          typeof result?.then === "function"
        ) {
          interleaved = true;
          return result.then(async (rows) => {
            releaseCommit();
            await committed;
            return rows;
          });
        }
        return result;
      },
    );

    let during;
    try {
      during = await fixture.request("GET", url);
    } finally {
      // Never leave the staged transaction open, even when the read fails.
      hook.mock.restore();
      releaseCommit();
      await committed;
    }
    assert.equal(interleaved, true, "the failure must commit inside the status read");
    assert.equal(during.status, 200, JSON.stringify(during.body));
    assert.deepEqual(
      { status: during.data.status, error: during.data.error },
      { status: "running", error: undefined },
      "a status read that started before the failure commit reports the state before it",
    );

    const after = await fixture.request("GET", url);
    assert.equal(after.status, 200, JSON.stringify(after.body));
    assert.equal(after.data.status, "failed");
    assert.deepEqual(after.data.error, failure);
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
    const callsBeforeRevocation = structuredClone(secretDriver.calls);

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
    // Only duplicate-name, plugin-policy and runtime-image refusals reach the status read; the
    // error recorded for this authorization denial keeps its own message internal.
    const job = await fixture.pool.query(
      "SELECT progress->'error' AS error FROM occ.agent_provisioning_work WHERE work_id = $1",
      [admitted.data.provisioning.workId],
    );
    assert.deepEqual(job.rows, [
      {
        error: { code: "PROVISIONING_REJECTED", message: "Agent provisioning could not complete." },
      },
    ]);
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
      secretDriver.calls,
      callsBeforeRevocation,
      "revoked initiating authority must not perform further Secret backend operations",
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
  "provisioning refuses credential-source Harness authentication before authorization or writes",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const fixture = await createFixture(context);
    const namespace = await fixture.bootstrapNamespace();
    // The source row exists only so the request names a real, ready id; admission must refuse
    // before it looks the source up, so its gateway and Secret details are irrelevant.
    const sourceId = `cs_${randomUUID()}`;
    await fixture.state.transact(async (unit) => {
      await unit.credentialSources.createCredentialSource({
        id: sourceId,
        namespaceId: namespace.id,
        name: `provisioning-source-${randomUUID()}`,
        type: "openai",
        config: {},
        secrets: {},
        driverId: "credential-gateway-provisioning",
        state: "registering",
        createdAt: new Date().toISOString(),
      });
      await unit.credentialSources.markCredentialSourceReady(namespace.id, sourceId);
    });
    const provision = () =>
      fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
        body: {
          requestId: requestId(),
          name: `Credential source ${randomUUID().slice(0, 8)}`,
          executionMode: "dedicated",
          configuration: { kind: "agent", values: { agents: { defaults: agentDefaults() } } },
          harnessAuth: { method: "credential_source", sourceId },
        },
      });
    const assertRefused = (response) => {
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.equal(response.error.code, "INVALID_REQUEST");
      assert.match(response.error.message, /does not support credential-source Harness/);
    };

    // The documented contract: even a caller who may operate the source is refused.
    assertRefused(await provision());

    // A caller who can create Agents and Configurations and administer the Installation, but
    // holds no credential_source:operate, must not bind an Agent to the source through
    // provisioning (the direct Agent path requires that grant).
    const principalId = await fixture.revokeCurrentPrincipal();
    const roleId = `role-provisioning-${randomUUID()}`;
    const bindingId = `binding-provisioning-${randomUUID()}`;
    await fixture.pool.query(
      "INSERT INTO occ.iam_roles (id, namespace_id, name, permissions) VALUES ($1, NULL, $2, $3::jsonb)",
      [
        roleId,
        `Provisioning without credential sources ${randomUUID()}`,
        JSON.stringify([
          { action: "administer", resourceKind: "installation" },
          { action: "create", resourceKind: "agent" },
          { action: "create", resourceKind: "configuration" },
        ]),
      ],
    );
    await fixture.pool.query(
      `INSERT INTO occ.iam_access_bindings
       (id, namespace_id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id)
       VALUES ($1, NULL, $2, NULL, $3, NULL, NULL)`,
      [bindingId, principalId, roleId],
    );
    try {
      assertRefused(await provision());
    } finally {
      await fixture.pool.query("DELETE FROM occ.iam_access_bindings WHERE id = $1", [bindingId]);
      await fixture.pool.query("DELETE FROM occ.iam_roles WHERE id = $1", [roleId]);
    }

    // Neither refusal stored a plan, queued work, created resources or recorded a denial.
    const resources = await fixture.pool.query(
      `SELECT
       (SELECT count(*)::integer FROM occ.agent_provisioning_work WHERE namespace_id = $1) AS plans,
       (SELECT count(*)::integer FROM occ.controller_work
        WHERE namespace_id = $1 AND work_kind = 'provisioning') AS work,
       (SELECT count(*)::integer FROM occ.agents WHERE namespace_id = $1) AS agents,
       (SELECT count(*)::integer FROM occ.configurations WHERE namespace_id = $1) AS configurations,
       (SELECT count(*)::integer FROM occ.audit_events
        WHERE namespace_id = $1 AND action LIKE 'openclaw.agents.provision%') AS audits`,
      [namespace.id],
    );
    assert.deepEqual(resources.rows[0], {
      plans: 0,
      work: 0,
      agents: 0,
      configurations: 0,
      audits: 0,
    });
  },
);

test(
  "provisioning requires Installation administer on top of every Namespace grant",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const fixture = await createFixture(context);
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const provision = () =>
      fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
        body: provisioningBody(namespace.id, secrets),
      });

    // The caller keeps every action on every Namespace resource kind, inside this Namespace
    // only, and loses its Installation grants.
    const principalId = await fixture.revokeCurrentPrincipal();
    const kinds = ["agent", "configuration", "secret", "service_account", "credential_source"];
    const actions = ["create", "read", "update", "delete", "deploy", "operate"];
    const policy = [
      [
        null,
        [
          { action: "read", resourceKind: "namespace" },
          { action: "read", resourceKind: "preset" },
          ...kinds.flatMap((resourceKind) => actions.map((action) => ({ action, resourceKind }))),
        ],
        namespace.id,
      ],
      [null, [{ action: "administer", resourceKind: "installation" }], null],
    ].map(([roleNamespace, permissions, bindingNamespace]) => ({
      roleId: `role-provisioning-${randomUUID()}`,
      bindingId: `binding-provisioning-${randomUUID()}`,
      roleNamespace,
      permissions,
      bindingNamespace,
    }));
    const grant = async ({ roleId, bindingId, roleNamespace, permissions, bindingNamespace }) => {
      await fixture.pool.query(
        "INSERT INTO occ.iam_roles (id, namespace_id, name, permissions) VALUES ($1, $2, $3, $4::jsonb)",
        [roleId, roleNamespace, `Provisioning ${randomUUID()}`, JSON.stringify(permissions)],
      );
      await fixture.pool.query(
        `INSERT INTO occ.iam_access_bindings
         (id, namespace_id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id)
         VALUES ($1, $2, $3, NULL, $4, NULL, NULL)`,
        [bindingId, bindingNamespace, principalId, roleId],
      );
    };
    try {
      await grant(policy[0]);
      const denied = await provision();
      assert.equal(denied.status, 403, JSON.stringify(denied.body));
      assert.equal(denied.error.code, "FORBIDDEN");
      const plans = await fixture.pool.query(
        "SELECT count(*)::integer AS plans FROM occ.agent_provisioning_work WHERE namespace_id = $1",
        [namespace.id],
      );
      assert.equal(plans.rows[0].plans, 0);

      // Installation administer is the only grant the refused caller lacked.
      await grant(policy[1]);
      const admitted = await provision();
      assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    } finally {
      for (const { roleId, bindingId } of policy) {
        await fixture.pool.query("DELETE FROM occ.iam_access_bindings WHERE id = $1", [bindingId]);
        await fixture.pool.query("DELETE FROM occ.iam_roles WHERE id = $1", [roleId]);
      }
    }
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
  "provisioning a duplicate Agent name fails permanently and says the name is taken",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const fixture = await createFixture(context);
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const name = `Duplicate ${randomUUID().slice(0, 8)}`;
    const first = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body: provisioningBody(namespace.id, secrets, { name }),
    });
    assert.equal(first.status, 202, JSON.stringify(first.body));
    await fixture.startWorker();
    const created = await waitFor("first Agent provisioning to succeed", async () => {
      const observed = await fixture.request("GET", first.data.provisioning.url);
      assert.equal(observed.status, 200, JSON.stringify(observed.body));
      return observed.data.status === "succeeded" ? observed.data : undefined;
    });
    fixture.cancelProvisioningAtTeardown(namespace.id, created.agentId);

    // Admission does not check names; the worker's Agent insert hits the unique name
    // constraint. The job must report that cause instead of the generic failure text.
    const duplicate = await fixture.request(
      "POST",
      `/namespaces/${namespace.id}/agents/provision`,
      { body: provisioningBody(namespace.id, secrets, { name }) },
    );
    assert.equal(duplicate.status, 202, JSON.stringify(duplicate.body));
    await waitFor("duplicate-name Agent provisioning to fail", async () => {
      const observed = await fixture.request("GET", duplicate.data.provisioning.url);
      assert.equal(observed.status, 200, JSON.stringify(observed.body));
      return observed.data.status === "failed" ? observed.data : undefined;
    });
    // The status read takes the job and the queue row in separate statements, so the
    // poll that first sees the failure can miss the recorded error. Read the settled job.
    const failed = await fixture.request("GET", duplicate.data.provisioning.url);
    assert.equal(failed.status, 200, JSON.stringify(failed.body));
    assert.equal(failed.data.status, "failed");
    assert.deepEqual(failed.data.error, {
      code: "PROVISIONING_REJECTED",
      message: "An Agent with this name already exists in this Namespace. Choose a different name.",
    });
    const work = await fixture.pool.query(
      "SELECT state, reason_code FROM occ.controller_work WHERE work_kind = 'provisioning' AND namespace_id = $1 AND idempotency_key = $2",
      [namespace.id, duplicate.data.provisioning.workId],
    );
    assert.deepEqual(work.rows, [
      { state: "failed_permanent", reason_code: "PROVISIONING_REJECTED" },
    ]);
    const agents = await fixture.pool.query("SELECT id FROM occ.agents WHERE namespace_id = $1", [
      namespace.id,
    ]);
    assert.deepEqual(
      agents.rows.map(({ id }) => id),
      [created.agentId],
    );
  },
);

test(
  "pending provisioning blocks deleting its Secrets; a failed plan's retry names the deleted one",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const configurationDriver = createProvisioningConfigurationDriver({
      id: "configuration-provisioning-secret-delete",
    });
    let configurationOutage = true;
    const createExact = configurationDriver.createExact;
    configurationDriver.createExact = async (configuration) => {
      if (configurationOutage) {
        throw new Error("synthetic Configuration outage");
      }
      return createExact(configuration);
    };
    const fixture = await createFixture(context, { configurationDriver });
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body: provisioningBody(namespace.id, secrets),
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    const secretPath = (secret) => `/namespaces/${namespace.id}/secrets/${secret.id}`;

    // Queued: no Configuration or Agent names these Secrets yet, only the accepted plan. Its
    // actor, who holds the grants a status read checks, sees the request as a consumer.
    const { workId } = admitted.data.provisioning;
    for (const secret of [secrets.slackBotToken, secrets.modelKey]) {
      const refused = await fixture.request("DELETE", secretPath(secret));
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.equal(
        refused.body.error.message,
        `The Secret is still referenced by pending Agent provisioning request ${workId}. Remove those references, or let provisioning finish, first.`,
      );
      const read = await fixture.request("GET", secretPath(secret));
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.deepEqual(read.data.consumers, {
        agents: [],
        configurations: [],
        credentialSources: [],
        provisioningRequests: [workId],
        unreadable: 0,
        truncated: false,
      });
    }

    await fixture.startWorker();
    const failed = await waitFor(
      "Agent provisioning to fail before its Configuration",
      async () => {
        const observed = await fixture.request("GET", admitted.data.provisioning.url);
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        return observed.data.status === "failed" ? observed.data : undefined;
      },
    );
    await fixture.stopWorker();
    assert.equal(failed.phase, "admitted");

    // A failed plan has no owner that would ever remove it, so it does not block deletion.
    const deleted = await fixture.request("DELETE", secretPath(secrets.slackBotToken));
    assert.equal(deleted.status, 204, JSON.stringify(deleted.body));

    // The plan can never run again: reading or retrying it names the deleted Secret
    // instead of answering 404 for a job that exists.
    configurationOutage = false;
    const gone = `Secret ${secrets.slackBotToken.id}, which this provisioning request uses, was deleted. Submit a new Agent provisioning request.`;
    for (const [method, path] of [
      ["GET", admitted.data.provisioning.url],
      ["POST", `${admitted.data.provisioning.url}/retry`],
    ]) {
      const refused = await fixture.request(method, path);
      assert.equal(refused.status, 409, `${method} ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.error.code, "RESOURCE_CONFLICT");
      assert.equal(refused.body.error.message, gone);
    }
    const work = await fixture.pool.query(
      "SELECT state FROM occ.controller_work WHERE idempotency_key = $1",
      [admitted.data.provisioning.workId],
    );
    assert.deepEqual(work.rows, [{ state: "failed_permanent" }], "a refused retry queues nothing");
  },
);

test(
  "a provisioning request its actor may no longer read is counted, never named, as a Secret consumer",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const fixture = await createFixture(context);
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    // No worker runs, so the request stays queued and keeps referencing both Secrets.
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body: provisioningBody(namespace.id, secrets),
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    const { workId } = admitted.data.provisioning;
    const secretPath = `/namespaces/${namespace.id}/secrets/${secrets.modelKey.id}`;
    assert.deepEqual(
      (await fixture.request("GET", secretPath)).data.consumers.provisioningRequests,
      [workId],
    );

    // A status read needs Agent create in the Namespace. Once a Restriction denies it, the
    // actor still reads and may delete the Secret, but no longer sees the request: it is only
    // counted, and the filtering is not itself a denied operation (no 403, no denial audit).
    await fixture.pool.query(
      `INSERT INTO occ.iam_restrictions (id, namespace_id, action, resource_kind, resource_id)
       VALUES ($1, $2, 'create', 'agent', NULL)`,
      [`restriction_${randomUUID()}`, namespace.id],
    );
    const denials = async () =>
      (
        await fixture.pool.query(
          "SELECT count(*)::int AS count FROM occ.audit_events WHERE namespace_id = $1 AND outcome = 'denied'",
          [namespace.id],
        )
      ).rows[0].count;
    const denialsBefore = await denials();
    const read = await fixture.request("GET", secretPath);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.deepEqual(read.data.consumers, {
      agents: [],
      configurations: [],
      credentialSources: [],
      provisioningRequests: [],
      unreadable: 1,
      truncated: false,
    });
    const refused = await fixture.request("DELETE", secretPath);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(
      refused.body.error.message,
      "The Secret is still referenced by 1 resource you cannot read. Remove those references first.",
    );
    for (const body of [read.body, refused.body]) {
      assert.doesNotMatch(JSON.stringify(body), new RegExp(workId));
    }
    const denialsAfter = await denials();
    assert.equal(denialsAfter, denialsBefore);
  },
);

test(
  "another administrator's pending provisioning request is counted, never named, as a Secret consumer",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const fixture = await createFixture(context);
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    // No worker runs, so administrator A's request stays queued and keeps referencing both Secrets.
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body: provisioningBody(namespace.id, secrets),
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    const { workId } = admitted.data.provisioning;

    // Administrator B holds A's Installation-wide administrator Role, so every grant a status
    // read checks passes; only the initiating-actor check keeps A's request from B.
    const bindings = await fixture.pool.query(
      `SELECT role_id FROM occ.iam_access_bindings
       WHERE identity_subject_id = $1 AND namespace_id IS NULL AND resource_kind IS NULL`,
      [await fixture.administratorPrincipalId()],
    );
    assert.equal(bindings.rows.length, 1, JSON.stringify(bindings.rows));
    const [{ role_id: administratorRoleId }] = bindings.rows;
    const second = {
      email: `postgres-agent-provisioning-second-${randomUUID()}@example.test`,
      password: `generated-password-${randomUUID()}`,
    };
    const created = await fixture.request("POST", "/api/auth/accounts", {
      body: { ...second, name: "Second administrator", roleId: administratorRoleId },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    // Account seeds scope their binding to the Installation resource; B also holds the Role
    // across the Installation, like the bootstrap administrator.
    await fixture.pool.query(
      `INSERT INTO occ.iam_access_bindings (id, identity_subject_id, role_id) VALUES ($1, $2, $3)`,
      [`binding_second_admin_${randomUUID()}`, created.data.principalId, administratorRoleId],
    );
    const secondSession = await signInToControllerApp(fixture.app, second);
    const status = await fixture.request("GET", admitted.data.provisioning.url, {
      session: secondSession,
    });
    assert.equal(status.status, 403, JSON.stringify(status.body));

    const secretPath = `/namespaces/${namespace.id}/secrets/${secrets.modelKey.id}`;
    const own = await fixture.request("GET", secretPath);
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.deepEqual(own.data.consumers.provisioningRequests, [workId]);

    const read = await fixture.request("GET", secretPath, { session: secondSession });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.deepEqual(read.data.consumers, {
      agents: [],
      configurations: [],
      credentialSources: [],
      provisioningRequests: [],
      unreadable: 1,
      truncated: false,
    });
    const refused = await fixture.request("DELETE", secretPath, { session: secondSession });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(
      refused.body.error.message,
      "The Secret is still referenced by 1 resource you cannot read. Remove those references first.",
    );
    for (const body of [read.body, refused.body]) {
      assert.doesNotMatch(JSON.stringify(body), new RegExp(workId));
    }
  },
);

test(
  "a Plugin Driver switch leaves the provisioning status readable; retry still refuses the plan",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const configurationDriver = createProvisioningConfigurationDriver({
      id: "configuration-provisioning-plugin-switch",
    });
    const createExact = configurationDriver.createExact;
    let configurationOutage = true;
    configurationDriver.createExact = async (configuration) => {
      if (configurationOutage) {
        throw new Error("synthetic Configuration outage");
      }
      return createExact(configuration);
    };
    const computeDriver = createRuntimeComputeDriver();
    const secretDriver = createTestSecretDriver({ id: "secret-provisioning" });
    const fixture = await createFixture(context, {
      computeDriver,
      configurationDriver,
      secretDriver,
      pluginDriver: new CodexPluginDriver(),
    });
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const pluginId = "codex-plugin:linear@openai-curated-remote";
    const body = provisioningBody(namespace.id, secrets, {
      plugins: { [pluginId]: { enabled: true } },
    });
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    await fixture.startWorker();
    const failed = await waitFor(
      "Agent provisioning to fail before its Configuration",
      async () => {
        const observed = await fixture.request("GET", admitted.data.provisioning.url);
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        return observed.data.status === "failed" ? observed.data : undefined;
      },
    );
    await fixture.stopWorker();
    // Rule out the Configuration outage as the cause of the retry refusal below.
    configurationOutage = false;

    // The administrator restarts the API with a Plugin Driver that does not offer the stored
    // plugin. Reading status reports the stored work: plugin admission belongs to writes.
    const switched = await createFixture(context, {
      computeDriver,
      configurationDriver,
      secretDriver,
      pluginDriver: new OCCPluginDriver(),
    });
    const status = await switched.request("GET", admitted.data.provisioning.url);
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.deepEqual(status.data, failed);

    // Retry would run the plan again, so it is still refused, naming the stored plugin
    // without a request-body detail, and queues nothing.
    const retried = await switched.request("POST", `${admitted.data.provisioning.url}/retry`);
    assert.equal(retried.status, 400, JSON.stringify(retried.body));
    assert.equal(retried.body.error.code, "INVALID_REQUEST");
    assert.match(
      retried.body.error.message,
      new RegExp(
        `^A plugin selection names a plugin that the selected Plugin Driver \\(occ-plugin\\) does not offer: ${pluginId}\\.`,
      ),
    );
    assert.equal(Object.hasOwn(retried.body.error, "details"), false);
    // A replay of the original request rechecks the stored plan, so it is refused the same way
    // and returns no progress.
    const provisionPath = `/namespaces/${namespace.id}/agents/provision`;
    const replayed = await switched.request("POST", provisionPath, { body });
    assert.equal(replayed.status, 400, JSON.stringify(replayed.body));
    assert.deepEqual(replayed.body.error, retried.body.error);
    const work = await switched.pool.query(
      "SELECT state FROM occ.controller_work WHERE idempotency_key = $1",
      [admitted.data.provisioning.workId],
    );
    assert.deepEqual(
      work.rows,
      [{ state: "failed_permanent" }],
      "a refused retry or replay queues nothing",
    );
  },
);

test(
  "a Plugin Driver switch before the worker runs rejects the provisioning work without retrying",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const configurationDriver = createProvisioningConfigurationDriver({
      id: "configuration-provisioning-plugin-switch-worker",
    });
    const computeDriver = createRuntimeComputeDriver();
    const secretDriver = createTestSecretDriver({ id: "secret-provisioning" });
    const fixture = await createFixture(context, {
      computeDriver,
      configurationDriver,
      secretDriver,
      pluginDriver: new CodexPluginDriver(),
    });
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    // A hosted-app plugin ID makes the refusal outgrow the 256-character status message.
    const pluginId = "codex-plugin:app-69312da8e4dc81919370cb86fd172b6c@openai-curated-remote";
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body: provisioningBody(namespace.id, secrets, { plugins: { [pluginId]: { enabled: true } } }),
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));

    // The Installation now selects a Plugin Driver that does not offer the stored plugin. Every
    // attempt would refuse the plan the same way, so the worker fails it on the first one.
    const switched = await createFixture(context, {
      computeDriver,
      configurationDriver,
      secretDriver,
      pluginDriver: new OCCPluginDriver(),
    });
    await switched.startWorker();
    await waitFor("the switched worker to reject the provisioning work", async () => {
      const observed = await switched.request("GET", admitted.data.provisioning.url);
      assert.equal(observed.status, 200, JSON.stringify(observed.body));
      return observed.data.status === "failed" ? observed.data : undefined;
    });
    await switched.stopWorker();
    const failed = await switched.request("GET", admitted.data.provisioning.url);
    assert.equal(failed.status, 200, JSON.stringify(failed.body));
    // The refusal names the stored plugin, as HTTP retry would, so Console can say why.
    assert.equal(failed.data.error.code, "PROVISIONING_REJECTED");
    assert.ok(
      failed.data.error.message.startsWith(
        `A plugin selection names a plugin that the selected Plugin Driver (occ-plugin) does not offer: ${pluginId}.`,
      ),
      failed.data.error.message,
    );
    // Cut to the 256-character cap with an ellipsis that says text is missing.
    assert.equal(Array.from(failed.data.error.message).length, 256);
    assert.ok(failed.data.error.message.endsWith("…"), failed.data.error.message);
    const work = await switched.pool.query(
      "SELECT state, reason_code, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
      [admitted.data.provisioning.workId],
    );
    assert.deepEqual(work.rows, [
      { state: "failed_permanent", reason_code: "PROVISIONING_REJECTED", attempt_count: 1 },
    ]);
  },
);

test(
  "dropping native worker support from the runtime image before the worker runs rejects dedicated OpenClaw provisioning",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const drivers = {
      computeDriver: createRuntimeComputeDriver(),
      configurationDriver: createProvisioningConfigurationDriver({
        id: "configuration-provisioning-native-support",
      }),
      secretDriver: createTestSecretDriver({ id: "secret-provisioning" }),
      // Dedicated native OpenClaw needs a full-containment provisioning Sandbox Driver.
      sandboxDriver: {
        id: "sandbox-provisioning",
        capability: "sandbox",
        implementation: "openshell",
        facets: ["networking", "filesystem", "process"],
        async provisionHarness() {
          assert.fail("a refused plan never reaches the Sandbox");
        },
        async cleanup() {},
      },
    };
    const fixture = await createFixture(context, {
      ...drivers,
      nativeWorkerSupport: "custom-image",
    });
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const body = provisioningBody(namespace.id, secrets);
    body.configuration.values.agents.defaults = {
      model: "openai/gpt-5",
      models: { "openai/gpt-5": { agentRuntime: { id: "openclaw" } } },
    };
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));

    // The Installation now runs a runtime image without native worker support. Every attempt
    // would refuse the plan the same way, so the worker fails it on the first one and says why.
    // The first recorded error settles it: a retried refusal would leave the work running.
    const switched = await createFixture(context, drivers);
    await switched.startWorker();
    const failed = await waitFor(
      "the switched worker to refuse the provisioning work",
      async () => {
        const row = await provisioningRow(switched.pool, namespace.id, body.requestId);
        return row.progress.error === undefined ? undefined : row;
      },
    );
    await switched.stopWorker();
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.progress.error, {
      code: "PROVISIONING_REJECTED",
      message: new NativeWorkerSupportError().message,
    });
    const work = await switched.pool.query(
      "SELECT state, reason_code, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
      [admitted.data.provisioning.workId],
    );
    assert.deepEqual(work.rows, [
      { state: "failed_permanent", reason_code: "PROVISIONING_REJECTED", attempt_count: 1 },
    ]);

    // Reading status reports the stored failure: native worker support is admission for writes.
    const status = await switched.request("GET", admitted.data.provisioning.url);
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(status.data.status, "failed");
    assert.deepEqual(status.data.error, failed.progress.error);
    // Retry would run the plan again, so it is still refused for the missing support.
    const retried = await switched.request("POST", `${admitted.data.provisioning.url}/retry`);
    assert.equal(retried.status, 400, JSON.stringify(retried.body));
    assert.equal(retried.body.error.message, new NativeWorkerSupportError().message);
  },
);

test(
  "a Compute gateway change before the worker runs rejects the provisioning work without retrying",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const computeDriver = createRuntimeComputeDriver();
    const workerEvents = [];
    const fixture = await createFixture(context, {
      computeDriver,
      onWorkerEvent: (event) => workerEvents.push(event),
      configurationDriver: createProvisioningConfigurationDriver({
        id: "configuration-provisioning-compute-refusal",
      }),
      secretDriver: createTestSecretDriver({ id: "secret-provisioning" }),
    });
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const body = provisioningBody(namespace.id, secrets);
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));

    // The Installation now enables dedicated runtime storage without gateway routing, so the
    // Kubernetes Compute Driver refuses the stored plan with its own error class. Every attempt
    // would refuse it the same way, so the worker fails it on the first one and says why.
    const unrouted = createTestKubernetesComputeDriver("compute-provisioning-unrouted", {
      repositoryCredentials: true,
    });
    computeDriver.validateAgentProvisioning = (input) => unrouted.validateAgentProvisioning(input);
    await fixture.startWorker();
    const failed = await waitFor("the worker to refuse the provisioning work", async () => {
      const row = await provisioningRow(fixture.pool, namespace.id, body.requestId);
      return row.progress.error === undefined ? undefined : row;
    });
    await fixture.stopWorker();
    const message =
      "The Compute Driver cannot provision this execution mode or gateway configuration.";
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.progress.error, { code: "PROVISIONING_REJECTED", message });
    const work = await fixture.pool.query(
      "SELECT state, reason_code, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
      [admitted.data.provisioning.workId],
    );
    assert.deepEqual(work.rows, [
      { state: "failed_permanent", reason_code: "PROVISIONING_REJECTED", attempt_count: 1 },
    ]);
    // The status keeps fixed text; the worker's log line names the Driver's reason.
    const completed = workerEvents.filter(
      (event) => event.event === "worker.completed" && event.code === "PROVISIONING_REJECTED",
    );
    assert.deepEqual(
      completed.map(({ outcome, reason }) => ({ outcome, reason })),
      [
        {
          outcome: "permanent",
          reason: "Dedicated Harness storage requires gateway routing and node enrollment.",
        },
      ],
    );

    // Reading status reports the stored failure rather than a 500 or a fresh refusal.
    const status = await fixture.request("GET", admitted.data.provisioning.url);
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(status.data.status, "failed");
    assert.deepEqual(status.data.error, failed.progress.error);
    // Retry runs the plan again, so it is refused as a conflict; the driver's text stays local.
    const retried = await fixture.request("POST", `${admitted.data.provisioning.url}/retry`);
    assert.equal(retried.status, 409, JSON.stringify(retried.body));
    assert.equal(retried.body.error.code, "RESOURCE_CONFLICT");
    assert.equal(retried.body.error.message, message);
    assert.doesNotMatch(JSON.stringify(retried.body), /node enrollment/);

    // A gateway setting in the caller's own plan that the Installation no longer accepts (its
    // trusted proxy CIDRs changed) is the caller's to fix, so status and retry name it.
    const proxied = provisioningBody(namespace.id, secrets);
    proxied.configuration.values.gateway = { trustedProxies: ["127.0.0.1/32"] };
    const matching = createTestKubernetesComputeDriver("compute-provisioning-loopback-proxy");
    computeDriver.validateAgentProvisioning = (input) => matching.validateAgentProvisioning(input);
    const admittedProxy = await fixture.request(
      "POST",
      `/namespaces/${namespace.id}/agents/provision`,
      { body: proxied },
    );
    assert.equal(admittedProxy.status, 202, JSON.stringify(admittedProxy.body));
    const moved = createTestKubernetesComputeDriver("compute-provisioning-moved-proxy", {
      gatewayTrustedProxyCidrs: ["10.42.0.0/16"],
    });
    computeDriver.validateAgentProvisioning = (input) => moved.validateAgentProvisioning(input);
    await fixture.startWorker();
    const proxyFailed = await waitFor(
      "the worker to refuse the stale gateway setting",
      async () => {
        const row = await provisioningRow(fixture.pool, namespace.id, proxied.requestId);
        return row.progress.error === undefined ? undefined : row;
      },
    );
    await fixture.stopWorker();
    const settingMessage =
      "Configuration setting gateway.trustedProxies must be omitted or match the Installation's network.gatewayTrustedProxyCidrs.";
    assert.deepEqual(proxyFailed.progress.error, {
      code: "PROVISIONING_REJECTED",
      message: settingMessage,
    });
    const proxyWork = await fixture.pool.query(
      "SELECT state, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
      [admittedProxy.data.provisioning.workId],
    );
    assert.deepEqual(proxyWork.rows, [{ state: "failed_permanent", attempt_count: 1 }]);
    const proxyRetried = await fixture.request(
      "POST",
      `${admittedProxy.data.provisioning.url}/retry`,
    );
    assert.equal(proxyRetried.status, 409, JSON.stringify(proxyRetried.body));
    assert.deepEqual(
      { code: proxyRetried.body.error.code, message: proxyRetried.body.error.message },
      { code: "RESOURCE_CONFLICT", message: settingMessage },
    );
  },
);

test(
  "a Harness authentication refusal of the caller's Configuration is named on create, replay, handoff, in the failed work and on retry",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const computeDriver = createRuntimeComputeDriver();
    // Kubernetes Compute raises this for a Codex Gateway setting it cannot rewrite; the
    // setting path can carry a submitted provider key, here with a control character.
    const settingRefusal = (key) =>
      `Configuration setting models.providers.${key}.models must be a list of objects: a dedicated Codex Gateway cannot apply it otherwise.`;
    // Exactly the 256-character status cap, counting the astral character once, so the
    // status keeps it whole.
    const fill = 256 - Array.from(settingRefusal("op\u0007enai\u{1F600}")).length;
    const refusal = settingRefusal(`op\u0007enai${"x".repeat(fill)}\u{1F600}`);
    assert.equal(Array.from(refusal).length, 256);
    const named = refusal.replace("\u0007", "?");
    let refusing = true;
    let harnessChecks = 0;
    computeDriver.validateHarnessAuth = () => {
      harnessChecks += 1;
      if (refusing) {
        throw new ConfigurationHarnessError(refusal);
      }
    };
    const fixture = await createFixture(context, {
      computeDriver,
      configurationDriver: createProvisioningConfigurationDriver({
        id: "configuration-provisioning-harness-refusal",
      }),
      secretDriver: createTestSecretDriver({ id: "secret-provisioning" }),
    });
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);

    // A fresh request is refused as deployment refuses it: a 400 naming the setting.
    const refused = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body: provisioningBody(namespace.id, secrets),
    });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.deepEqual(
      { code: refused.body.error.code, message: refused.body.error.message },
      { code: "INVALID_REQUEST", message: named },
    );

    // The Driver refuses the stored plan only after admission: the worker fails the work on
    // its first attempt, and the failed work's message names the setting.
    refusing = false;
    const body = provisioningBody(namespace.id, secrets);
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    refusing = true;
    await fixture.startWorker();
    const failed = await waitFor("the worker to refuse the provisioning work", async () => {
      const row = await provisioningRow(fixture.pool, namespace.id, body.requestId);
      return row.progress.error === undefined ? undefined : row;
    });
    await fixture.stopWorker();
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.progress.error, { code: "PROVISIONING_REJECTED", message: named });
    const work = await fixture.pool.query(
      "SELECT state, reason_code, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
      [admitted.data.provisioning.workId],
    );
    assert.deepEqual(work.rows, [
      { state: "failed_permanent", reason_code: "PROVISIONING_REJECTED", attempt_count: 1 },
    ]);

    // Status reports the stored failure without rechecking Harness authentication.
    const checksBeforeStatus = harnessChecks;
    const status = await fixture.request("GET", admitted.data.provisioning.url);
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(status.data.status, "failed");
    assert.deepEqual(status.data.error, failed.progress.error);
    assert.equal(harnessChecks, checksBeforeStatus, "a status read runs no Harness check");
    // A replay of the admitted request checks the stored plan again and names the setting too.
    const provisionPath = `/namespaces/${namespace.id}/agents/provision`;
    const replayed = await fixture.request("POST", provisionPath, { body });
    assert.equal(replayed.status, 400, JSON.stringify(replayed.body));
    assert.deepEqual(
      { code: replayed.body.error.code, message: replayed.body.error.message },
      { code: "INVALID_REQUEST", message: named },
    );
    // Retry runs the plan again and names the setting too.
    const retried = await fixture.request("POST", `${admitted.data.provisioning.url}/retry`);
    assert.equal(retried.status, 400, JSON.stringify(retried.body));
    assert.deepEqual(
      { code: retried.body.error.code, message: retried.body.error.message },
      { code: "INVALID_REQUEST", message: named },
    );
    // Any other Harness authentication refusal keeps the fixed 409.
    computeDriver.validateHarnessAuth = () => {
      throw new Error("Harness authentication is incompatible with the selected topology.");
    };
    const conflicted = await fixture.request("POST", `${admitted.data.provisioning.url}/retry`);
    assert.equal(conflicted.status, 409, JSON.stringify(conflicted.body));
    assert.deepEqual(
      { code: conflicted.body.error.code, message: conflicted.body.error.message },
      {
        code: "RESOURCE_CONFLICT",
        message: "The configured model, authentication, or channel bindings cannot be provisioned.",
      },
    );

    // Admission and the worker fences check the placeholder "provisioning" Harness version;
    // deployment checks the approved runtime version. A Driver that refuses only the latter
    // fails the work at the deployment handoff, and its message is named as well. Over the
    // cap, format characters and lone surrogates become "?" and the cut keeps whole
    // characters.
    const emoji = "\u{1F600}".repeat(220);
    computeDriver.validateHarnessAuth = (harness) => {
      if (harness.version !== "provisioning") {
        throw new ConfigurationHarnessError(settingRefusal(`op\u200Benai\uD800${emoji}`));
      }
    };
    const handoffBody = provisioningBody(namespace.id, secrets);
    const handedOff = await fixture.request("POST", provisionPath, { body: handoffBody });
    assert.equal(handedOff.status, 202, JSON.stringify(handedOff.body));
    await fixture.startWorker();
    const handoffFailed = await waitFor("the handoff to refuse the provisioning work", async () => {
      const row = await provisioningRow(fixture.pool, namespace.id, handoffBody.requestId);
      return row.progress.error === undefined ? undefined : row;
    });
    await fixture.stopWorker();
    assert.equal(handoffFailed.status, "failed");
    assert.notEqual(handoffFailed.agent_id, null, "the handoff runs after the Agent exists");
    const shown = Array.from(settingRefusal(`op?enai?${emoji}`))
      .slice(0, 255)
      .join("");
    assert.deepEqual(handoffFailed.progress.error, {
      code: "PROVISIONING_REJECTED",
      message: `${shown}…`,
    });

    // Authorization comes first: a caller who lost its grants gets 403, not the setting.
    computeDriver.validateHarnessAuth = () => {
      throw new ConfigurationHarnessError(refusal);
    };
    await fixture.revokeCurrentPrincipal();
    const denied = await fixture.request("POST", provisionPath, { body });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, "FORBIDDEN");
    assert.doesNotMatch(JSON.stringify(denied.body), /models\.providers/);
  },
);

// Provision Agents through the worker and return their settled provisioning views.
async function provisionAgents(fixture, namespaceId, count = 1) {
  const secrets = await createProvisioningSecrets(fixture, namespaceId);
  const admitted = [];
  for (let index = 0; index < count; index += 1) {
    const response = await fixture.request("POST", `/namespaces/${namespaceId}/agents/provision`, {
      body: provisioningBody(namespaceId, secrets),
    });
    assert.equal(response.status, 202, JSON.stringify(response.body));
    admitted.push(response.data.provisioning.url);
  }
  await fixture.startWorker();
  const created = [];
  try {
    for (const url of admitted) {
      created.push(
        await waitFor("Agent provisioning to succeed", async () => {
          const observed = await fixture.request("GET", url);
          assert.equal(observed.status, 200, JSON.stringify(observed.body));
          return observed.data.status === "succeeded" ? observed.data : undefined;
        }),
      );
    }
  } finally {
    await fixture.stopWorker();
  }
  for (const provisioned of created) {
    fixture.cancelProvisioningAtTeardown(namespaceId, provisioned.agentId);
  }
  return created;
}

function recordingConfigurationDriver() {
  const configurationDriver = createProvisioningConfigurationDriver({
    id: "configuration-provisioning",
  });
  const deleted = [];
  const deleteStored = configurationDriver.delete.bind(configurationDriver);
  configurationDriver.delete = async (reference) => {
    deleted.push(reference.id);
    return deleteStored(reference);
  };
  return { configurationDriver, deleted };
}

async function selectConfiguration(fixture, namespaceId, agentId, configurationId) {
  const switched = await fixture.request("PATCH", `/namespaces/${namespaceId}/agents/${agentId}`, {
    body: { configurationId },
  });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  assert.equal(switched.data.configurationId, configurationId);
}

async function createAgentConfiguration(fixture, namespaceId) {
  const created = await fixture.request("POST", `/namespaces/${namespaceId}/configurations`, {
    body: { kind: "agent", values: { agents: { defaults: agentDefaults() } } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.data.id;
}

async function provisioningConfigurationId(pool, workId) {
  const result = await pool.query(
    "SELECT configuration_id FROM occ.agent_provisioning_work WHERE work_id = $1",
    [workId],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0].configuration_id;
}

async function assertConfigurationDeletionRefused(fixture, namespaceId, configurationId, message) {
  const path = `/namespaces/${namespaceId}/configurations/${configurationId}`;
  const refused = await fixture.request("DELETE", path);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "RESOURCE_CONFLICT");
  assert.match(refused.body.error.message, message);
  const kept = await fixture.request("GET", path);
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
}

test(
  "pending provisioning blocks deleting its ServiceAccount; a failed plan's retry names the deleted one",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const fixture = await createFixture(context);
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const created = await fixture.request("POST", `/namespaces/${namespace.id}/service-accounts`, {
      body: { name: `provisioning-account-${randomUUID().slice(0, 8)}` },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const account = created.data;
    // Admission would reject this account, which has no Backend-issued credential, so store
    // the plan directly; the worker fails it for the same reason before any effect.
    const actorId = await fixture.administratorPrincipalId();
    const body = provisioningBody(namespace.id, secrets);
    const workId = `agent-provisioning:${randomUUID().replaceAll("-", "")}`;
    await fixture.state.transact((unit) =>
      unit.provisioning.create({
        workId,
        namespaceId: namespace.id,
        actorId,
        requestId: body.requestId,
        requestFingerprint: "0".repeat(64),
        plan: {
          name: body.name,
          configuration: body.configuration,
          harnessAuth: {
            method: "codex_pat",
            source: { kind: "service_account", namespaceId: account.namespaceId, id: account.id },
          },
          executionMode: body.executionMode,
          drivers: {
            compute: fixture.computeDriver.id,
            configuration: fixture.configurationDriver.id,
            iam: "native-iam",
          },
        },
      }),
    );
    const provisioningUrl = `/namespaces/${namespace.id}/agents/provision/${workId}`;
    const accountPath = `/namespaces/${namespace.id}/service-accounts/${account.id}`;

    // Queued: no Agent names this account yet, only the accepted plan.
    const refused = await fixture.request("DELETE", accountPath);
    assert.equal(refused.status, 409, `DELETE ${JSON.stringify(refused.body)}`);
    assert.equal(
      refused.body.error.message,
      "An Agent draft, active revision, pending deployment, or pending Agent provisioning request still references the ServiceAccount. Remove those references, or let provisioning finish, first.",
    );

    // The account has no issued credential, so the worker fails the plan before any effect.
    await fixture.startWorker();
    await waitFor("Agent provisioning to fail before its Configuration", async () => {
      const { rows } = await fixture.pool.query(
        "SELECT status FROM occ.agent_provisioning_work WHERE work_id = $1",
        [workId],
      );
      return rows[0]?.status === "failed" ? true : undefined;
    });
    await fixture.stopWorker();
    const workState = async () =>
      (
        await fixture.pool.query(
          "SELECT state FROM occ.controller_work WHERE idempotency_key = $1",
          [workId],
        )
      ).rows;
    const failedWork = await workState();

    // A failed plan has no owner that would ever remove it, so it does not block deletion.
    const deleted = await fixture.request("DELETE", accountPath);
    assert.equal(deleted.status, 204, JSON.stringify(deleted.body));

    const gone = `ServiceAccount ${account.id}, which this provisioning request uses, was deleted. Submit a new Agent provisioning request.`;
    for (const [method, path] of [
      ["GET", provisioningUrl],
      ["POST", `${provisioningUrl}/retry`],
    ]) {
      const answered = await fixture.request(method, path);
      assert.equal(answered.status, 409, `${method} ${JSON.stringify(answered.body)}`);
      assert.equal(answered.body.error.code, "RESOURCE_CONFLICT");
      assert.equal(answered.body.error.message, gone);
    }
    assert.deepEqual(await workState(), failedWork, "a refused retry queues nothing");
  },
);

test(
  "a provisioned Agent's first Configuration is deletable after the Agent switches away",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const { configurationDriver, deleted } = recordingConfigurationDriver();
    const fixture = await createFixture(context, { configurationDriver });
    const namespace = await fixture.bootstrapNamespace();
    const [created] = await provisionAgents(fixture, namespace.id);
    const replacement = await createAgentConfiguration(fixture, namespace.id);
    await selectConfiguration(fixture, namespace.id, created.agentId, replacement);

    // No Agent selects the first Configuration, so the succeeded provisioning record
    // releases it and the ordinary deletion proceeds.
    const configurationPath = `/namespaces/${namespace.id}/configurations/${created.configurationId}`;
    const removed = await fixture.request("DELETE", configurationPath);
    assert.equal(removed.status, 204, JSON.stringify(removed.body));
    assert.deepEqual(deleted, [created.configurationId]);
    const gone = await fixture.request("GET", configurationPath);
    assert.equal(gone.status, 404, JSON.stringify(gone.body));
    assert.equal(await provisioningConfigurationId(fixture.pool, created.workId), null);
    const status = await fixture.request("GET", created.url);
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(status.data.status, "succeeded");
    assert.equal(status.data.agentId, created.agentId);
    assert.equal(status.data.configurationId, undefined);
  },
);

test(
  "a provisioned Agent's first Configuration stays held while the Agent selects it, including after switching back",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const { configurationDriver, deleted } = recordingConfigurationDriver();
    const fixture = await createFixture(context, { configurationDriver });
    const namespace = await fixture.bootstrapNamespace();
    const [created] = await provisionAgents(fixture, namespace.id);
    const agentReference = /An Agent still references the Configuration/;
    await assertConfigurationDeletionRefused(
      fixture,
      namespace.id,
      created.configurationId,
      agentReference,
    );
    // The database refuses a release while the provisioned Agent selects the Configuration.
    await assert.rejects(
      fixture.pool.query(
        "UPDATE occ.agent_provisioning_work SET configuration_id = NULL WHERE work_id = $1",
        [created.workId],
      ),
      { code: "23514", message: /terminal agent provisioning work is immutable/ },
    );

    const replacement = await createAgentConfiguration(fixture, namespace.id);
    // A release may only clear the Configuration, never move the record to another one.
    await assert.rejects(
      fixture.pool.query(
        "UPDATE occ.agent_provisioning_work SET configuration_id = $2 WHERE work_id = $1",
        [created.workId, replacement],
      ),
      { code: "23514" },
    );
    await selectConfiguration(fixture, namespace.id, created.agentId, replacement);
    await selectConfiguration(fixture, namespace.id, created.agentId, created.configurationId);
    await assertConfigurationDeletionRefused(
      fixture,
      namespace.id,
      created.configurationId,
      agentReference,
    );
    assert.equal(
      await provisioningConfigurationId(fixture.pool, created.workId),
      created.configurationId,
    );
    assert.deepEqual(deleted, []);

    await selectConfiguration(fixture, namespace.id, created.agentId, replacement);
    const removed = await fixture.request(
      "DELETE",
      `/namespaces/${namespace.id}/configurations/${created.configurationId}`,
    );
    assert.equal(removed.status, 204, JSON.stringify(removed.body));
    assert.deepEqual(deleted, [created.configurationId]);
  },
);

test(
  "a provisioned Configuration another Agent selects stays held after its own Agent switches away",
  { ...requiresPostgres, timeout: 90_000 },
  async (context) => {
    const { configurationDriver, deleted } = recordingConfigurationDriver();
    const fixture = await createFixture(context, { configurationDriver });
    const namespace = await fixture.bootstrapNamespace();
    const [first, second] = await provisionAgents(fixture, namespace.id, 2);
    // Swap the two Agents' Configurations: each provisioned Configuration loses its own
    // Agent but is still selected by the other one.
    await selectConfiguration(fixture, namespace.id, first.agentId, second.configurationId);
    await selectConfiguration(fixture, namespace.id, second.agentId, first.configurationId);
    for (const provisioned of [first, second]) {
      await assertConfigurationDeletionRefused(
        fixture,
        namespace.id,
        provisioned.configurationId,
        /An Agent still references the Configuration/,
      );
      assert.equal(
        await provisioningConfigurationId(fixture.pool, provisioned.workId),
        provisioned.configurationId,
      );
    }
    assert.deepEqual(deleted, []);

    // Once the other Agent leaves too, the first provisioned Configuration is free.
    await selectConfiguration(fixture, namespace.id, second.agentId, second.configurationId);
    const removed = await fixture.request(
      "DELETE",
      `/namespaces/${namespace.id}/configurations/${first.configurationId}`,
    );
    assert.equal(removed.status, 204, JSON.stringify(removed.body));
    assert.deepEqual(deleted, [first.configurationId]);
    await assertConfigurationDeletionRefused(
      fixture,
      namespace.id,
      second.configurationId,
      /An Agent still references the Configuration/,
    );
  },
);

test(
  "a Namespace is deletable after provisioning fails with its Configuration effect settled",
  { ...requiresPostgres, timeout: 90_000 },
  async (context) => {
    const fixture = await createFixture(context);
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const name = `Duplicate ${randomUUID().slice(0, 8)}`;
    const first = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body: provisioningBody(namespace.id, secrets, { name }),
    });
    assert.equal(first.status, 202, JSON.stringify(first.body));
    await fixture.startWorker();
    try {
      const created = await waitFor("first Agent provisioning to succeed", async () => {
        const observed = await fixture.request("GET", first.data.provisioning.url);
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        return observed.data.status === "succeeded" ? observed.data : undefined;
      });
      const duplicate = await fixture.request(
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        { body: provisioningBody(namespace.id, secrets, { name }) },
      );
      assert.equal(duplicate.status, 202, JSON.stringify(duplicate.body));
      await waitFor("duplicate-name Agent provisioning to fail", async () => {
        const work = await fixture.pool.query(
          "SELECT state FROM occ.controller_work WHERE idempotency_key = $1",
          [duplicate.data.provisioning.workId],
        );
        return work.rows[0]?.state === "failed_permanent" ? true : undefined;
      });

      // The worker wrote the Configuration through its Driver and recorded the receipt,
      // then the Agent insert hit the name conflict and rolled back the metadata. The
      // job is terminal and its effect is settled, so nothing remains in flight.
      const failed = await fixture.pool.query(
        `SELECT status, completed_phase, progress->'pendingEffect' AS pending,
                progress->'effectReceipt' AS receipt
         FROM occ.agent_provisioning_work WHERE work_id = $1`,
        [duplicate.data.provisioning.workId],
      );
      assert.equal(failed.rowCount, 1);
      const [row] = failed.rows;
      assert.equal(row.status, "failed");
      assert.equal(row.completed_phase, "admitted");
      assert.equal(row.pending?.kind, "configuration");
      assert.equal(row.receipt?.kind, row.pending.kind);
      assert.equal(row.receipt?.owner, row.pending.owner);
      assert.equal(row.receipt?.targetId, row.pending.targetId);

      // Empty the Namespace of everything else, as an administrator would.
      const agentPath = `/namespaces/${namespace.id}/agents/${created.agentId}`;
      const deleting = await fixture.request("DELETE", agentPath);
      assert.equal(deleting.status, 202, JSON.stringify(deleting.body));
      await waitFor(
        "the first Agent deletion to finish",
        async () => {
          const observed = await fixture.request("GET", agentPath);
          return observed.status === 404 ? true : undefined;
        },
        30_000,
      );
      const configuration = await fixture.request(
        "DELETE",
        `/namespaces/${namespace.id}/configurations/${created.configurationId}`,
      );
      assert.ok([200, 204, 404].includes(configuration.status), JSON.stringify(configuration.body));
      for (const secret of Object.values(secrets)) {
        const removed = await fixture.request(
          "DELETE",
          `/namespaces/${namespace.id}/secrets/${secret.id}`,
        );
        assert.ok([200, 204].includes(removed.status), JSON.stringify(removed.body));
      }

      const deleted = await fixture.request("DELETE", `/namespaces/${namespace.id}`);
      assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
      assert.equal(deleted.data.status, "deleting");
    } finally {
      await fixture.stopWorker();
    }
  },
);

async function createFailedPreHandoffAgent(fixture) {
  const namespace = await fixture.bootstrapNamespace();
  const secrets = await createProvisioningSecrets(fixture, namespace.id);
  const body = provisioningBody(namespace.id, secrets);
  const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
    body,
  });
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

function failingTransportDriver(reportStoredCredentials = () => false) {
  const computeDriver = createRuntimeComputeDriver();
  const provisionRuntimeCredentials = computeDriver.provisionAgentRuntimeCredentials;
  const getRuntimeCredentialStatus = computeDriver.getAgentRuntimeCredentialStatus;
  computeDriver.provisionAgentRuntimeCredentials = async (...args) => {
    await provisionRuntimeCredentials(...args);
    throw new Error("synthetic pre-handoff transport failure");
  };
  computeDriver.getAgentRuntimeCredentialStatus = async (...args) =>
    reportStoredCredentials()
      ? getRuntimeCredentialStatus(...args)
      : { transportConfigured: false };
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

test(
  "Stop and Delete cancel failed pre-handoff provisioning Agents without deployment resurrection",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    let reportStoredCredentials = false;
    const stopFixture = await createFixture(context, {
      computeDriver: failingTransportDriver(() => reportStoredCredentials),
    });
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
    reportStoredCredentials = true;
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
  "Delete finishes after failed pre-handoff provisioning leaves its effect unsettled",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const computeDriver = failingTransportDriver();
    const fixture = await createFixture(context, { computeDriver, leaseDurationMs: 3_000 });
    const target = await createFailedPreHandoffAgent(fixture);
    const agentPath = `/namespaces/${target.namespace.id}/agents/${target.failed.agentId}`;
    const deleting = await fixture.request("DELETE", agentPath);
    assert.equal(deleting.status, 202, JSON.stringify(deleting.body));

    // Nothing settles a cancelled effect, so deletion itself must resolve it,
    // but only after a lease has passed since the cancellation.
    await fixture.startWorker();
    try {
      await waitFor("the Agent deletion to wait out the provisioning lease", async () => {
        const deferred = await fixture.pool.query(
          `SELECT 1 FROM occ.audit_events
           WHERE action = 'reconcile' AND resource_kind = 'agent' AND resource_id = $1
             AND details->>'reasonCode' = 'PROVISIONING_EFFECT_PENDING'`,
          [target.failed.agentId],
        );
        return deferred.rowCount > 0 ? true : undefined;
      });
      assert.equal(
        computeDriver.calls.some(
          ({ operation, agentId }) =>
            operation === "deleteAgentRuntimeCredentials" && agentId === target.failed.agentId,
        ),
        false,
      );
      await waitFor(
        "the Agent deletion to finish",
        async () => {
          const observed = await fixture.request("GET", agentPath);
          if (observed.status === 404) {
            return true;
          }
          assert.equal(observed.status, 200, JSON.stringify(observed.body));
          const work = await fixture.pool.query(
            `SELECT state, reason_code FROM occ.controller_work
             WHERE namespace_id = $1 AND agent_id = $2 AND agent_target = 'deleted'`,
            [target.namespace.id, target.failed.agentId],
          );
          assert.notEqual(work.rows[0]?.state, "failed_permanent", JSON.stringify(work.rows));
          return undefined;
        },
        20_000,
      );
    } finally {
      await fixture.stopWorker();
    }
    // The shared database may hold other tests' deleting Agents; count only this one.
    assert.equal(
      computeDriver.calls.filter(
        ({ operation, agentId }) =>
          operation === "deleteAgentRuntimeCredentials" && agentId === target.failed.agentId,
      ).length,
      1,
    );
    const provisioning = await fixture.pool.query(
      "SELECT 1 FROM occ.agent_provisioning_work WHERE work_id = $1",
      [target.admitted.data.provisioning.workId],
    );
    assert.equal(provisioning.rowCount, 0);
    const agents = await fixture.pool.query("SELECT 1 FROM occ.agents WHERE namespace_id = $1", [
      target.namespace.id,
    ]);
    assert.equal(agents.rowCount, 0, "no Agent may keep the Namespace non-empty");
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

    // Another Agent cannot take over the reserved Configuration either.
    const otherConfiguration = await fixture.request(
      "POST",
      `/namespaces/${namespace.id}/configurations`,
      { body: { kind: "agent", values: {} } },
    );
    assert.equal(otherConfiguration.status, 201, JSON.stringify(otherConfiguration.body));
    const other = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
      body: { name: "unreserved-agent", configurationId: otherConfiguration.data.id },
    });
    assert.equal(other.status, 201, JSON.stringify(other.body));
    const borrowed = [
      await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
        body: { name: "borrowing-agent", configurationId: failed.configurationId },
      }),
      await fixture.request("PATCH", `/namespaces/${namespace.id}/agents/${other.data.id}`, {
        body: { configurationId: failed.configurationId },
      }),
    ];
    assert.deepEqual(
      borrowed.map(({ status, body }) => [status, body.error?.message]),
      [
        [
          409,
          "The Configuration is reserved for provisioning and is not available for this operation.",
        ],
        [
          409,
          "The Configuration is reserved for provisioning and is not available for this operation.",
        ],
      ],
    );

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
    const agentReserved =
      "The Agent is reserved for provisioning. Stop or delete it, or retry its failed provisioning request.";
    assert.deepEqual(
      reserved.map(({ body }) => [body.error.code, body.error.message]),
      [
        ["RESOURCE_CONFLICT", agentReserved],
        ["RESOURCE_CONFLICT", agentReserved],
        ["RESOURCE_CONFLICT", agentReserved],
        [
          "RESOURCE_CONFLICT",
          "The Configuration is reserved for provisioning and is not available for this operation.",
        ],
      ],
      "each refusal names the provisioning reservation, not a duplicate",
    );
    // The transport write has no receipt, so the failed job still counts as in flight.
    const occupied = await fixture.request("DELETE", `/namespaces/${namespace.id}`);
    assert.equal(occupied.status, 409, JSON.stringify(occupied.body));
    assert.match(occupied.body.error.message, /pending Agent provisioning\.$/);

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
