import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  ConfigurationHarnessError,
  PostgresPlatformState,
  ProvisioningSecretDriverError,
  ServiceAccountDriverNotConfiguredError,
} from "../../packages/occ/src/index.ts";
import { composePostgresDevelopment } from "../helpers/password-hasher.mjs";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import { ConfigurationConflictError } from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import { currentComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { provisioningProgress } from "../../packages/occ/src/agent-provisioning.ts";
import {
  conformanceKubernetesOptions,
  createTestKubernetesComputeDriver,
} from "../helpers/kubernetes-compute.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { occLogLine } from "../helpers/occ-log-line.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import {
  authenticatedHeaders,
  signInToControllerApp as signInAccount,
} from "../helpers/auth-session.mjs";
import {
  ensureDevelopmentBootstrap,
  privateBootstrapDirectory,
} from "../helpers/bootstrap-installation.mjs";
import { waitForLockWaiter } from "../helpers/postgres-lock-waits.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { withNamespaceLockHeld } from "../helpers/postgres-namespace-lock.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
import { expireWorkLease, makeWorkDue } from "../helpers/postgres-worker-revision-support.mjs";

const adminEmail = "postgres-agent-provisioning-v2@example.test";
const adminPassword = "postgres-agent-provisioning-password";
const authBaseURL = "http://127.0.0.1";
const authSecret = "postgres-agent-provisioning-auth-secret-32-bytes";
let bootstrapPromise;
const administratorSessions = new Map();
const uuidV4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const identifier = (prefix) => new RegExp(`^${prefix}_${uuidV4}$`);
const defaultModel = "codex/gpt-6-astra";

// The bootstrap administrator signs in once per file (and per set of sign-in options): every
// fixture's app reads the same stored session (same database and auth secret). No test ends it,
// and a revoked administrator binding is restored at teardown. Any other account or password
// signs in on every call.
function signInToControllerApp(app, credentials, ...options) {
  if (credentials.email !== adminEmail || credentials.password !== adminPassword) {
    return signInAccount(app, credentials, ...options);
  }
  const key = JSON.stringify(options);
  if (!administratorSessions.has(key)) {
    administratorSessions.set(
      key,
      signInAccount(app, credentials, ...options).catch((error) => {
        administratorSessions.delete(key);
        throw error;
      }),
    );
  }
  return administratorSessions.get(key);
}

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
    // The development Compute fixture has no workspace storage. Real file setup
    // is covered by the Kubernetes provisioning integration.
    initialWorkspaceFiles: {},
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

// Stands in for the controller's 90 s Configuration settle window passing: the pending create's
// database-clock start moves 91 s back, and its deferred work becomes claimable now. The
// effect's owner and target stay exactly as the worker recorded them.
async function elapseConfigurationSettleWindow(fixture, workId) {
  const aged = await fixture.pool.query(
    `UPDATE occ.agent_provisioning_work
     SET progress = jsonb_set(
       progress,
       '{pendingEffect,startedAt}',
       to_jsonb(to_char((clock_timestamp() - interval '91 seconds') AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
     )
     WHERE work_id = $1
       AND progress -> 'pendingEffect' ->> 'kind' = 'configuration'
       AND progress -> 'pendingEffect' ? 'startedAt'`,
    [workId],
  );
  assert.equal(aged.rowCount, 1, "the pending Configuration create must record its start");
  const woken = await makeWorkDue(fixture.pool, { key: workId, state: "queued" });
  assert.equal(woken.rowCount, 1, "the provisioning work must be queued");
}

// Runs the worker until the first Configuration create has failed with an unknown outcome and
// the next attempt has deferred inside the settle window, then stops it.
async function provisionUntilConfigurationSettling(fixture, admitted, sent) {
  const { workId } = admitted.data.provisioning;
  await fixture.startWorker();
  const deferred = await waitFor(
    "the absent Configuration create to wait out its settle window",
    async () => {
      const observed = await fixture.request("GET", admitted.data.provisioning.url);
      assert.equal(observed.status, 200, JSON.stringify(observed.body));
      assert.notEqual(observed.data.status, "failed", JSON.stringify(observed.body));
      const work = await fixture.pool.query(
        `SELECT state, attempt_count,
           available_at > clock_timestamp() + interval '30 seconds' AS deferred
         FROM occ.controller_work WHERE idempotency_key = $1`,
        [workId],
      );
      const [row] = work.rows;
      return row?.state === "queued" && row.deferred ? row : undefined;
    },
  );
  await fixture.stopWorker();
  // Only the attempt that sent the create spent an attempt; nothing was sent again yet.
  assert.equal(deferred.attempt_count, 1);
  assert.equal(sent.length, 1);
  const record = await fixture.pool.query(
    "SELECT progress -> 'error' ->> 'code' AS code FROM occ.agent_provisioning_work WHERE work_id = $1",
    [workId],
  );
  assert.deepEqual(record.rows, [{ code: "PROVISIONING_OUTCOME_UNKNOWN" }]);
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

/** The provisioning jobs and Agents a Namespace holds; a refused request stores neither. */
async function storedProvisioningCounts(pool, namespaceId) {
  const { rows } = await pool.query(
    `SELECT
     (SELECT count(*)::integer FROM occ.agent_provisioning_work WHERE namespace_id = $1) AS jobs,
     (SELECT count(*)::integer FROM occ.agents WHERE namespace_id = $1) AS agents`,
    [namespaceId],
  );
  return rows[0];
}

function installationDrivers({
  computeDriver,
  configurationDriver,
  secretDriver,
  repoDriver,
  pluginDriver,
  sandboxDriver,
  credentialGatewayDriver,
}) {
  return {
    installation: {
      occ: { cluster: "postgres-agent-provisioning" },
      logging: {},
      backend: [
        ...(repoDriver === undefined
          ? []
          : [
              {
                id: "provisioning-repositories",
                type: "github",
                configuration: { registryPath: "/unused/provisioning/registry.json" },
                drivers: { repo: repoDriver.id },
              },
            ]),
        ...(credentialGatewayDriver === undefined
          ? []
          : [
              {
                id: "provisioning-credential-gateway",
                type: "openshell",
                configuration: {
                  endpoint: "http://127.0.0.1:8080",
                  insecureTransport: "network-policy",
                },
                drivers: {
                  sandbox: sandboxDriver.id,
                  credential_gateway: credentialGatewayDriver.id,
                },
              },
            ]),
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
        ...(credentialGatewayDriver === undefined
          ? {}
          : {
              credential_gateway: {
                id: credentialGatewayDriver.id,
                implementation: credentialGatewayDriver.implementation,
                configuration: {},
              },
            }),
      },
    },
    computeDriver,
    configurationDriver,
    secretDriver,
    ...(sandboxDriver === undefined ? {} : { sandboxDriver }),
    ...(credentialGatewayDriver === undefined ? {} : { credentialGatewayDriver }),
    ...(repoDriver === undefined ? {} : { repositoryPolicy: repoDriver }),
    ...(pluginDriver === undefined ? {} : { pluginDriver }),
    createIAMDriver: (state) =>
      new NativeIAMDriver(state, { id: "native-iam", implementation: "native" }),
  };
}

// Runs `before(statement, values, backendPid)` ahead of each statement a worker transaction sends,
// and sends the statement once it settles. Lock-order tests use it to pause the worker at one
// exact statement; the paused transaction then runs unchanged against the real database.
// Callback-style calls, such as `pool.query` for the work queue's claim and heartbeat, skip the
// hook.
function holdWorkerStatements(pool, before) {
  pool.on("connect", (client) => {
    const query = client.query.bind(client);
    client.query = (config, values, callback) =>
      typeof config === "string" && typeof values !== "function" && callback === undefined
        ? Promise.resolve(before(config, values, client.processID)).then(() =>
            query(config, values),
          )
        : query(config, values, callback);
  });
}

// The statement every Namespace-first path (Stop, Delete, the provisioning fences and deploy
// admission) uses to take the Namespace lock.
const namespaceLockStatement = /\bFROM occ\.namespaces\s+WHERE id = \$1\b[^;]*\bFOR UPDATE\s*$/;

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
  const teardownWorkCancellations = [];
  const drivers = installationDrivers({
    computeDriver,
    configurationDriver,
    secretDriver,
    repoDriver: options.repoDriver,
    pluginDriver: options.pluginDriver,
    sandboxDriver: options.sandboxDriver,
    credentialGatewayDriver: options.credentialGatewayDriver,
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
    try {
      // Queued work stays in the database the file's later tests share; cancel it so no later
      // worker picks it up (finding 1616), even when the test failed before its end.
      for (const { workId, message } of teardownWorkCancellations) {
        const claim = await claimProvisioningWork(pool, workId, { ifQueued: true });
        if (claim !== undefined) {
          const cancelled = await state.transact((unit) =>
            unit.provisioning.cancel(claim, { code: "PROVISIONING_CANCELLED", message }),
          );
          assert.equal(cancelled.status, "cancelled", workId);
        }
      }
    } finally {
      await app.close?.();
      await pool.end();
    }
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
    if (options.beforeWorkerStatement !== undefined) {
      holdWorkerStatements(workerPool, options.beforeWorkerStatement);
    }
    const started = createControllerWorker({
      pool: workerPool,
      drivers,
      pollIntervalMs: 15,
      leaseDurationMs: options.leaseDurationMs ?? 30_000,
      maxAttempts: 3,
      emit: (event) => {
        options.onWorkerEvent?.(event);
        // stopAfterProvisioning: this persistence case ends at durable handoff, before
        // credential service dispatch. stopWorkerAfter: the run ends inside the pass that
        // emitted the event, so a retry whose jittered backoff is already due cannot be claimed
        // before the test stops the worker (finding 1610).
        if (
          (options.stopAfterProvisioning && event.code === "PROVISIONING_DEPLOYMENT_PENDING") ||
          options.stopWorkerAfter?.(event)
        ) {
          workerCompletion ??= started.stop();
        }
      },
    });
    worker = started;
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

  // Cancel this provisioning work at teardown if it is still queued then.
  function cancelQueuedWorkAtTeardown(workId, message) {
    teardownWorkCancellations.push({ workId, message });
  }

  return {
    administratorPrincipalId,
    app,
    bootstrapNamespace,
    cancelProvisioningAtTeardown,
    cancelQueuedWorkAtTeardown,
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

// With ifQueued, work that is no longer queued is left alone and returns undefined.
async function claimProvisioningWork(pool, workId, { ifQueued = false } = {}) {
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
  if (ifQueued && claimed.rowCount === 0) {
    return undefined;
  }
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
      requestId: body.requestId,
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

    assert.equal(replay.data.provisioning.requestId, body.requestId);
    // The same actor may submit the same plan twice. Each job reports the request that admitted it.
    const otherId = requestId();
    const other = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body: { ...body, requestId: otherId },
    });
    assert.equal(other.status, 202);
    const otherJob = other.data.provisioning;
    fixture.cancelQueuedWorkAtTeardown(otherJob.workId, "Finished the request identity check.");
    assert.equal(otherJob.requestId, otherId);
    assert.notEqual(otherJob.workId, admitted.data.provisioning.workId);
    const otherStatus = await fixture.request("GET", otherJob.url);
    assert.equal(otherStatus.status, 200);
    assert.deepEqual(otherStatus.data, otherJob);

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
  "provisioning status judges claim liveness by the database clock, not the controller clock",
  requiresPostgres,
  async (context) => {
    const fixture = await createFixture(context);
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body: provisioningBody(namespace.id, secrets),
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    const { workId } = admitted.data.provisioning;
    const statusPath = `/namespaces/${namespace.id}/agents/provision/${encodeURIComponent(workId)}`;
    const apiStatus = async () => {
      const observed = await fixture.request("GET", statusPath);
      assert.equal(observed.status, 200, JSON.stringify(observed.body));
      return observed.data.status;
    };
    // The real State read and status derivation with a controller clock skewed far from
    // PostgreSQL's; the controller route above runs with the real clock (the composed app
    // takes no clock option).
    const statusAt = (instant) =>
      fixture.state.read(async (state) => {
        const found = await state.provisioning.findWithWork(workId);
        assert.notEqual(found?.work, undefined, "the provisioning job must join its queue row");
        return provisioningProgress(found.record, found.work, new Date(instant)).status;
      });
    const setLease = async (interval) => {
      const updated = await fixture.pool.query(
        `UPDATE occ.controller_work
         SET lease_expires_at = clock_timestamp() + $2::interval
         WHERE idempotency_key = $1 AND state = 'claimed'`,
        [workId, interval],
      );
      assert.equal(updated.rowCount, 1, "test must move the exact claimed lease");
    };

    const claim = await claimProvisioningWork(fixture.pool, workId);
    try {
      assert.equal(await apiStatus(), "running");
      // A controller clock ahead of the lease still reports the live claim.
      assert.equal(await statusAt("2999-01-01T00:00:00Z"), "running");

      // An expired claim is waiting for a new worker, not running.
      await setLease("-1 second");
      assert.equal(await apiStatus(), "queued");
      // A controller clock behind the lease still reports the expired claim as waiting.
      assert.equal(await statusAt("1970-01-01T00:00:00Z"), "queued");
    } finally {
      // Cancel under a live lease so no later worker in this database recovers the job.
      await setLease("10 minutes");
      const cancelled = await fixture.state.transact((unit) =>
        unit.provisioning.cancel(claim, {
          code: "PROVISIONING_CANCELLED",
          message: "lease liveness test completed without worker dispatch",
        }),
      );
      assert.equal(cancelled.status, "cancelled");
    }
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
    const repoDriver = new GitHubRepositoryPolicy(
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
    const status = await waitFor(
      "Agent provisioning to queue its initial deployment wait",
      async () => {
        const observed = await fixture.request("GET", admitted.data.provisioning.url);
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        assert.notEqual(observed.data.status, "failed", JSON.stringify(observed.body));
        // Admission publishes revisionId before the worker queues its activation
        // wait. Inspect the handoff only after that deferral has committed.
        return observed.data.revisionId !== undefined && observed.data.status === "queued"
          ? observed.data
          : undefined;
      },
    );
    await fixture.stopWorker();
    assert.equal(status.status, "queued");
    assert.match(status.agentId, identifier("agt"));
    assert.match(status.configurationId, identifier("cfg"));
    // Handoff is done; the deployment has not reported a wait, so the job names its own deferral
    // rather than reading like one never claimed (finding 1634).
    assert.equal(status.attemptCount, 0);
    const firstDeployment = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/agents/${status.agentId}/deployments/${status.revisionId}`,
    );
    assert.equal(firstDeployment.status, 200, JSON.stringify(firstDeployment.body));
    const deploymentWait = firstDeployment.data.progress?.lastAttempt;
    assert.deepEqual(
      status.progress,
      deploymentWait == null || deploymentWait.code === "RECONCILIATION_PENDING"
        ? {
            phase: "deployment",
            lastAttempt: {
              at: status.updatedAt,
              code: "PROVISIONING_DEPLOYMENT_PENDING",
              message: "Waiting for the initial deployment to complete.",
            },
          }
        : { phase: "deployment", lastAttempt: deploymentWait },
    );

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
    assert.equal(work.rows[0].state, "queued");
  },
);

// Finding 1145: the request refuses repository bindings the Compute topology cannot deliver.
// Work it already accepted is rechecked by the worker and retry until the Agent exists, so a
// topology change after admission fails the work before it creates the Agent.
test(
  "a repository topology change before the worker runs fails the provisioning work before its Agent",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const initial = await createFixture(context);
    const namespace = await initial.bootstrapNamespace();
    const repoDriver = new GitHubRepositoryPolicy(
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
            namespaces: [{ namespaceId: namespace.id, profiles: ["git-read"] }],
          },
        ],
      },
      { sessionDurationSeconds: 600 },
    );
    const topology = createTestKubernetesComputeDriver("provisioning-topology-change", {
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
    });
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const body = {
      ...provisioningBody(namespace.id, secrets, {
        repositoryAccess: {
          defaultProfile: "git-read",
          repositories: [{ repositoryRef: "project" }],
        },
      }),
      pluginApprovers: [],
    };
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));

    // The topology now cannot deliver repository credentials (as with a Sandbox selected).
    computeDriver.validateRepositoryCredentials = () => {
      throw new Error("synthetic topology refusal");
    };
    await fixture.startWorker();
    const failed = await waitFor("the worker to refuse the repository topology", async () => {
      const row = await provisioningRow(fixture.pool, namespace.id, body.requestId);
      return row.progress.error === undefined ? undefined : row;
    });
    await fixture.stopWorker();
    // The status keeps the fixed text; retry answers Agent create's 409.
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.progress.error, {
      code: "PROVISIONING_REJECTED",
      message: "Agent provisioning could not complete.",
    });
    assert.equal(failed.agent_id, null, "the refusal comes before the work creates its Agent");
    const message =
      "The selected Compute Driver cannot deliver repository credentials to this Harness topology.";
    const retried = await fixture.request("POST", `${admitted.data.provisioning.url}/retry`);
    assert.equal(retried.status, 409, JSON.stringify(retried.body));
    assert.equal(retried.body.error.code, "RESOURCE_CONFLICT");
    assert.equal(retried.body.error.message, message);
  },
);

for (const authMethod of ["api_key", "codex_pat"]) {
  test(
    `${authMethod} provisioning grants existing Secret access and hands off one revision`,
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      let deploymentReady = false;
      const computeDriver = createRuntimeComputeDriver();
      const prepareRevision = computeDriver.prepareRevision.bind(computeDriver);
      computeDriver.prepareRevision = async (...args) => ({
        ...(await prepareRevision(...args)),
        ready: deploymentReady,
      });
      const fixture = await createFixture(context, { computeDriver });
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
      // Until the worker runs, the queued plan is a consumer of its Harness Secret, whichever
      // Secret-backed method it uses.
      const pending = await fixture.request(
        "GET",
        `/namespaces/${namespace.id}/secrets/${secrets.modelKey.id}`,
      );
      assert.equal(pending.status, 200, JSON.stringify(pending.body));
      assert.deepEqual(pending.data.consumers.provisioningRequests, [
        admitted.data.provisioning.workId,
      ]);

      await fixture.startWorker();
      // This suite proves the real API, worker and PostgreSQL lifecycle with its
      // existing development Compute fixture, not Kubernetes or model execution.
      const handoff = await waitFor("initial deployment to remain pending", async () => {
        const observed = await fixture.request("GET", admitted.data.provisioning.url);
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        return observed.data.revisionId !== undefined ? observed.data : undefined;
      });
      assert.notEqual(handoff.status, "succeeded");
      deploymentReady = true;
      const status = await waitFor("Agent provisioning to succeed", async () => {
        const observed = await fixture.request("GET", admitted.data.provisioning.url);
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        if (observed.data.revisionId !== undefined) {
          const deployment = await fixture.request(
            "GET",
            `/namespaces/${namespace.id}/agents/${observed.data.agentId}/deployments/${observed.data.revisionId}`,
          );
          assert.notEqual(deployment.data.status, "failed", JSON.stringify(deployment.body));
        }
        return observed.data.status === "succeeded" ? observed.data : undefined;
      });
      assert.equal(status.status, "succeeded");
      assert.equal(status.agentId, handoff.agentId);
      assert.equal(status.revisionId, handoff.revisionId);
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
  "a provisioning status past handoff names its deployment's wait only to a reader of that deployment",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    // Finding 1634: past handoff the job defers without a lease or spent attempts while its
    // first deployment converges, so status and attemptCount alone read like a job never claimed.
    const computeDriver = createRuntimeComputeDriver();
    const prepareRevision = computeDriver.prepareRevision.bind(computeDriver);
    computeDriver.prepareRevision = async (...args) => ({
      ...(await prepareRevision(...args)),
      ready: false,
    });
    const fixture = await createFixture(context, { computeDriver });
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body: provisioningBody(namespace.id, secrets),
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    await fixture.startWorker();
    let handoff;
    try {
      // The unready runtime keeps the deployment pending with its own named wait.
      handoff = await waitFor("the first deployment to name its wait", async () => {
        const observed = await fixture.request("GET", admitted.data.provisioning.url);
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        return observed.data.revisionId !== undefined &&
          observed.data.progress?.lastAttempt?.code === "REVISION_INCOMPLETE"
          ? observed.data
          : undefined;
      });
    } finally {
      await fixture.stopWorker();
    }
    fixture.cancelProvisioningAtTeardown(namespace.id, handoff.agentId);
    assert.notEqual(handoff.status, "succeeded");
    assert.equal(handoff.progress.phase, "deployment");
    assert.equal(handoff.progress.lastAttempt.message, "Waiting for the runtime to become ready.");

    // The deployment's wait needs agent_revision read, which the provisioning read does not
    // check. Without it the job still reads, but names only its own deferral.
    await fixture.pool.query(
      `INSERT INTO occ.iam_restrictions (id, namespace_id, action, resource_kind, resource_id)
       VALUES ($1, $2, 'read', 'agent_revision', $3)`,
      [`restriction_${randomUUID()}`, namespace.id, handoff.revisionId],
    );
    const deploymentPath = `/namespaces/${namespace.id}/agents/${handoff.agentId}/deployments/${handoff.revisionId}`;
    assert.equal((await fixture.request("GET", deploymentPath)).status, 403);
    const restricted = await fixture.request("GET", admitted.data.provisioning.url);
    assert.equal(restricted.status, 200, JSON.stringify(restricted.body));
    assert.equal(restricted.data.revisionId, handoff.revisionId);
    assert.deepEqual(restricted.data.progress, {
      phase: "deployment",
      lastAttempt: {
        // The job's own deferral is stamped by its last checkpoint.
        at: restricted.data.updatedAt,
        code: "PROVISIONING_DEPLOYMENT_PENDING",
        message: "Waiting for the initial deployment to complete.",
      },
    });

    // Settle the job so no queued work outlives this test in the shared database.
    const stopped = await fixture.request(
      "POST",
      `/namespaces/${namespace.id}/agents/${handoff.agentId}/stop`,
    );
    assert.equal(stopped.status, 202, JSON.stringify(stopped.body));
    await fixture.startWorker();
    try {
      const settled = await waitFor("the stopped provisioning job to settle", async () => {
        const observed = await fixture.request("GET", admitted.data.provisioning.url);
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        return ["succeeded", "failed"].includes(observed.data.status) ? observed.data : undefined;
      });
      assert.equal(settled.error?.code, "REVISION_STOPPED", JSON.stringify(settled));
      assert.equal(Object.hasOwn(settled, "progress"), false);
    } finally {
      await fixture.stopWorker();
    }
  },
);

test(
  "initial provisioning settles when a stop interrupts its first deployment",
  { ...requiresPostgres, timeout: 90_000 },
  async (context) => {
    let firstRevisionId;
    const computeDriver = createRuntimeComputeDriver();
    const prepareRevision = computeDriver.prepareRevision.bind(computeDriver);
    // Keep the first revision unready until the owner stops the Agent.
    computeDriver.prepareRevision = async (revision, operationContext) => ({
      ...(await prepareRevision(revision, operationContext)),
      ready: firstRevisionId !== undefined && revision.id !== firstRevisionId,
    });
    const fixture = await createFixture(context, { computeDriver });
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body: provisioningBody(namespace.id, secrets),
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    await fixture.startWorker();
    try {
      const handoff = await waitFor("the first deployment to be admitted", async () => {
        const observed = await fixture.request("GET", admitted.data.provisioning.url);
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        return observed.data.revisionId !== undefined ? observed.data : undefined;
      });
      firstRevisionId = handoff.revisionId;
      fixture.cancelProvisioningAtTeardown(namespace.id, handoff.agentId);
      const agentPath = `/namespaces/${namespace.id}/agents/${handoff.agentId}`;
      const stopped = await fixture.request("POST", `${agentPath}/stop`);
      assert.equal(stopped.status, 202, JSON.stringify(stopped.body));

      const settled = await waitFor("initial provisioning to settle", async () => {
        const observed = await fixture.request("GET", admitted.data.provisioning.url);
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        return ["succeeded", "failed"].includes(observed.data.status) ? observed.data : undefined;
      });
      const first = await fixture.request("GET", `${agentPath}/deployments/${handoff.revisionId}`);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.data.error?.code, "REVISION_STOPPED");
      assert.equal(settled.status, "failed", JSON.stringify(settled));
      assert.equal(settled.agentId, handoff.agentId);
      assert.equal(settled.revisionId, handoff.revisionId);
      assert.deepEqual(settled.error, {
        code: "REVISION_STOPPED",
        message: "The Agent was stopped before its first deployment finished.",
      });

      // Stop remains a permanent audited failure of the original provisioning request.
      const work = await fixture.pool.query(
        "SELECT state, reason_code FROM occ.controller_work WHERE idempotency_key = $1",
        [admitted.data.provisioning.workId],
      );
      assert.deepEqual(work.rows, [{ state: "failed_permanent", reason_code: "REVISION_STOPPED" }]);
      const audit = await fixture.pool.query(
        `SELECT kind, outcome, details->>'code' AS code
         FROM occ.audit_events
         WHERE namespace_id = $1
           AND action = 'openclaw.agents.provision.failure'
           AND details->>'workId' = $2`,
        [namespace.id, admitted.data.provisioning.workId],
      );
      assert.deepEqual(audit.rows, [
        { kind: "mutation", outcome: "failure", code: "REVISION_STOPPED" },
      ]);
      const retried = await fixture.request("POST", `${admitted.data.provisioning.url}/retry`);
      assert.equal(retried.status, 409, JSON.stringify(retried.body));
      const revisions = await fixture.state.read((view) =>
        view.revisions.listRevisions(namespace.id, handoff.agentId),
      );
      assert.deepEqual(
        revisions.map(({ id }) => id),
        [handoff.revisionId],
      );
    } finally {
      await fixture.stopWorker();
    }
  },
);

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
  "a provisioning failure takes the Namespace lock before its claimed work row",
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

    // Stopping or deleting a provisioned Agent locks the Namespace, then the Agent, then this
    // claimed work row (cancelByAgent). Hold the Namespace until the worker's permanent failure
    // waits on it; the waiting failure must not hold the work row yet, or the two deadlock.
    let committed;
    try {
      await withNamespaceLockHeld(fixture.pool, namespace.id, async (lock) => {
        committed = fixture.state.transact(async (unit) => {
          const current = await unit.provisioning.findByWorkId(workId);
          await unit.provisioning.recordFailure(
            claim,
            {
              completedPhase: current.completedPhase,
              progress: { ...current.progress, error: failure },
            },
            { disposition: "permanent", ...failure },
          );
        });
        // Surface an early failure through the await below instead of an unhandled rejection.
        committed.catch(() => {});
        // No worker runs here, so the only backend that can wait on this lock is the failure's.
        await lock.waitForBlocked("the failure's real wait on the Namespace lock");
        await lock.assertNotHeld(
          "SELECT state FROM occ.controller_work WHERE idempotency_key = $1 FOR UPDATE NOWAIT",
          [workId],
          "a failure waiting for the Namespace must not already hold its work row",
        );
      });
      await committed;
    } finally {
      await committed?.catch(() => {});
    }

    const after = await fixture.request("GET", url);
    assert.equal(after.status, 200, JSON.stringify(after.body));
    assert.equal(after.data.status, "failed");
    assert.deepEqual(after.data.error, failure);
  },
);

for (const harnessAuth of ["api_key", "credential_source"]) {
  test(
    harnessAuth === "api_key"
      ? "provisioning worker reauthorizes after admission and revoked authority creates no backend effects"
      : "provisioning worker reauthorizes an accepted source after only its exact operate grant is revoked",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const sourceBacked = harnessAuth === "credential_source";
      const drivers = sourceBacked ? sourceProvisioningDrivers() : {};
      const fixture = await createFixture(context, drivers);
      const namespace = await fixture.bootstrapNamespace();
      let body;
      let session = fixture.session;
      let revokeAuthority = () => fixture.revokeCurrentPrincipal();
      if (sourceBacked) {
        const { source } = await createProvisioningModelSource(fixture, namespace.id);
        body = sourceProvisioningBody(source.id, "openclaw");
        // Give a separate requester only the required provisioning permissions. The API also
        // requires Installation administer; this Role has no wildcard or Secret permission.
        const roleId = `role-provisioning-${randomUUID()}`;
        const sourceRoleId = `role-source-${randomUUID()}`;
        await fixture.pool.query(
          `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
           VALUES ($1, NULL, $2, $3::jsonb), ($4, $5, $6, $7::jsonb)`,
          [
            roleId,
            `Source provisioning requester ${randomUUID()}`,
            JSON.stringify([
              { action: "administer", resourceKind: "installation" },
              { action: "create", resourceKind: "agent" },
              { action: "create", resourceKind: "configuration" },
            ]),
            sourceRoleId,
            namespace.id,
            `Exact model source operator ${randomUUID()}`,
            JSON.stringify([{ action: "operate", resourceKind: "credential_source" }]),
          ],
        );
        const requester = {
          email: `source-provisioning-${randomUUID()}@example.test`,
          password: `generated-password-${randomUUID()}`,
        };
        const created = await fixture.request("POST", "/api/auth/accounts", {
          body: { ...requester, name: "Source provisioning requester", roleId },
        });
        assert.equal(created.status, 201, JSON.stringify(created.body));
        const principalId = created.data.principalId;
        session = await signInToControllerApp(fixture.app, requester);
        const sourceBindingId = `binding-source-${randomUUID()}`;
        for (const [id, selectedRoleId, kind, resourceId] of [
          [`binding-provisioning-${randomUUID()}`, roleId, null, null],
          [sourceBindingId, sourceRoleId, "credential_source", source.id],
        ]) {
          await fixture.pool.query(
            `INSERT INTO occ.iam_access_bindings
           (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
            [id, namespace.id, principalId, selectedRoleId, kind, resourceId],
          );
        }
        revokeAuthority = async () => {
          const revoked = await fixture.pool.query(
            "DELETE FROM occ.iam_access_bindings WHERE id = $1 RETURNING id",
            [sourceBindingId],
          );
          assert.equal(revoked.rowCount, 1, "only the requester's exact source grant is revoked");
          const iam = new NativeIAMDriver(fixture.state);
          const installation = await fixture.state.loadInstallation();
          for (const [action, resource] of [
            ["administer", { kind: "installation", id: installation.id }],
            ["create", { kind: "agent", namespaceId: namespace.id, id: namespace.id }],
            ["create", { kind: "configuration", namespaceId: namespace.id, id: namespace.id }],
          ]) {
            const decision = await iam.authorize({ principalId, action, resource });
            assert.equal(decision.allowed, true, `${action} ${resource.kind} must remain allowed`);
          }
          const sourceAccess = await iam.authorize({
            principalId,
            action: "operate",
            resource: { kind: "credential_source", namespaceId: namespace.id, id: source.id },
          });
          assert.equal(sourceAccess.allowed, false, "the exact model source must be denied");
        };
      } else {
        const secrets = await createProvisioningSecrets(fixture, namespace.id);
        body = provisioningBody(namespace.id, secrets);
      }
      const admitted = await fixture.request(
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        {
          body,
          session,
        },
      );
      assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
      const callsBeforeRevocation = structuredClone(fixture.secretDriver.calls);
      const runtimeCallsBeforeRevocation = structuredClone(fixture.computeDriver.calls);
      const externalOperations = [
        ...["createExact", "inspectExact"].map((method) =>
          context.mock.method(fixture.configurationDriver, method),
        ),
        ...(sourceBacked
          ? [
              "listSourceTypes",
              "registerSource",
              "updateSource",
              "sourceStatus",
              "removeSource",
              "attachForRevision",
              "attachmentStatus",
              "withdraw",
            ].map((method) => context.mock.method(drivers.credentialGatewayDriver, method))
          : []),
        ...(sourceBacked
          ? ["provisionHarness", "cleanup"].map((method) =>
              context.mock.method(drivers.sandboxDriver, method),
            )
          : []),
      ];
      await revokeAuthority();
      await fixture.startWorker();
      const work = await waitFor(
        "provisioning work to fail after authority revocation",
        async () => {
          const observed = await fixture.pool.query(
            "SELECT state, reason_code FROM occ.controller_work WHERE work_kind = 'provisioning' AND namespace_id = $1 AND idempotency_key = $2",
            [namespace.id, admitted.data.provisioning.workId],
          );
          assert.equal(observed.rowCount, 1);
          return observed.rows[0].state === "failed_permanent" ? observed.rows[0] : undefined;
        },
      );
      await fixture.stopWorker();
      assert.equal(work.reason_code, "PROVISIONING_REJECTED");
      // Only duplicate-name, plugin-policy and runtime-image refusals reach the status read; the
      // error recorded for this authorization denial keeps its own message internal.
      const job = await fixture.pool.query(
        "SELECT progress->'error' AS error FROM occ.agent_provisioning_work WHERE work_id = $1",
        [admitted.data.provisioning.workId],
      );
      assert.deepEqual(job.rows, [
        {
          error: {
            code: "PROVISIONING_REJECTED",
            message: "Agent provisioning could not complete.",
          },
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
        fixture.secretDriver.calls,
        callsBeforeRevocation,
        "revoked initiating authority must not perform further Secret backend operations",
      );
      assert.deepEqual(
        fixture.computeDriver.calls,
        runtimeCallsBeforeRevocation,
        "revoked authority must not perform runtime operations",
      );
      for (const operation of externalOperations) {
        assert.equal(operation.mock.callCount(), 0, "revoked authority must not contact a backend");
      }
      const record = await provisioningRow(fixture.pool, namespace.id, body.requestId);
      assert.equal(record.completed_phase, "admitted");
      assert.equal(record.agent_id, null);
      assert.equal(record.configuration_id, null);
      const resources = await fixture.pool.query(
        `SELECT
       (SELECT count(*)::integer FROM occ.agents WHERE namespace_id = $1) AS agents,
       (SELECT count(*)::integer FROM occ.configurations WHERE namespace_id = $1) AS configurations,
       (SELECT count(*)::integer FROM occ.agent_revisions WHERE namespace_id = $1) AS revisions,
       (SELECT count(*)::integer FROM occ.secrets WHERE namespace_id = $1) AS secrets,
       (SELECT count(*)::integer FROM occ.iam_access_bindings
         WHERE namespace_id = $1 AND resource_kind = 'credential_source') AS source_grants`,
        [namespace.id],
      );
      assert.deepEqual(resources.rows[0], {
        agents: 0,
        configurations: 0,
        revisions: 0,
        secrets: sourceBacked ? 1 : 4,
        source_grants: 0,
      });
    },
  );
}

// The gateway is the external credential-store boundary. These cases use real HTTP,
// PostgreSQL checkpoints, Native IAM and Kubernetes authentication admission; they do
// not claim OpenShell injection or a live model turn.
function sourceProvisioningDrivers() {
  const stored = new Set();
  const credentialGatewayDriver = {
    id: "credential-gateway-provisioning",
    capability: "credential_gateway",
    implementation: "test-credential-store",
    validateSourceConfig() {},
    async listSourceTypes() {
      return [
        {
          type: "openai",
          config: [],
          secrets: [{ name: "api_key", required: true }],
          rotation: "none",
          harnessAuth: { modelProvider: "openai", loginMode: "api_key" },
        },
      ];
    },
    async registerSource({ source }) {
      stored.add(source.id);
      return { state: "ready" };
    },
    async updateSource() {
      return { state: "ready" };
    },
    async sourceStatus({ source }) {
      return { state: stored.has(source.id) ? "ready" : "absent" };
    },
    async removeSource({ source }) {
      stored.delete(source.id);
    },
    async attachForRevision() {
      assert.fail("this case ends at provisioning handoff");
    },
    async attachmentStatus() {
      assert.fail("this case ends at provisioning handoff");
    },
    async withdraw() {
      assert.fail("this case has no deployed Sandbox");
    },
  };
  const sandboxDriver = {
    id: "sandbox-source-provisioning",
    capability: "sandbox",
    implementation: "test-provisioning",
    facets: ["networking", "filesystem", "process"],
    async provisionHarness() {
      assert.fail("this case ends at provisioning handoff");
    },
    async cleanup() {},
  };
  const topology = new KubernetesComputeDriver(
    conformanceKubernetesOptions({ gatewayTrustedProxyCidrs: ["127.0.0.1/32"] }),
    { id: "source-provisioning-topology", sandboxDriver, credentialGatewayDriver },
  );
  const computeDriver = createRuntimeComputeDriver();
  computeDriver.validateHarnessAuth = topology.validateHarnessAuth.bind(topology);
  // Namespace placement and actual transport effects remain the established runtime fixture.
  computeDriver.resolveSandboxNamespace = async (namespace) => namespace;
  return { computeDriver, sandboxDriver, credentialGatewayDriver };
}

async function createProvisioningModelSource(fixture, namespaceId) {
  const secret = await createNamespaceSecret(fixture, namespaceId, "gateway-model-key");
  const registered = await fixture.request(
    "POST",
    `/namespaces/${namespaceId}/credential-sources`,
    {
      body: { name: "provisioning-model", type: "openai", secrets: { api_key: secret.ref } },
    },
  );
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  return { secret, source: registered.data };
}

function sourceProvisioningBody(sourceId, harness) {
  const { agents, models } = createHarnessConfiguration(
    harness,
    harness === "openclaw" ? "gpt-5" : "gpt-6-astra",
  );
  return {
    requestId: requestId(),
    name: `Source ${harness} ${randomUUID().slice(0, 8)}`,
    executionMode: "dedicated",
    configuration: {
      kind: "agent",
      values: { agents, models },
    },
    harnessAuth: { method: "credential_source", sourceId },
  };
}

for (const harness of ["openclaw", "codex"]) {
  test(
    `guided ${harness} provisioning holds its model source and grants only source access`,
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const fixture = await createFixture(context, {
        ...sourceProvisioningDrivers(),
        stopAfterProvisioning: true,
      });
      const namespace = await fixture.bootstrapNamespace();
      const { secret, source } = await createProvisioningModelSource(fixture, namespace.id);
      const body = sourceProvisioningBody(source.id, harness);
      const admitted = await fixture.request(
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        { body },
      );
      assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
      const queued = await provisioningRow(fixture.pool, namespace.id, body.requestId);
      assert.equal(queued.agent_id, null);
      // The accepted model reference holds the source before an Agent exists.
      const deleted = await fixture.request(
        "DELETE",
        `/namespaces/${namespace.id}/credential-sources/${source.id}`,
      );
      assert.equal(deleted.status, 409, JSON.stringify(deleted.body));
      const replay = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
        body,
      });
      assert.equal(replay.status, 202, JSON.stringify(replay.body));
      assert.equal(replay.data.provisioning.workId, admitted.data.provisioning.workId);
      await fixture.startWorker();
      const status = await waitFor("source provisioning to hand off", async () => {
        const observed = await fixture.request("GET", admitted.data.provisioning.url);
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        assert.notEqual(observed.data.status, "failed", JSON.stringify(observed.body));
        // Provisioning succeeds only after activation; this fixture stops at its queued handoff.
        return observed.data.revisionId !== undefined && observed.data.status === "queued"
          ? observed.data
          : undefined;
      });
      await fixture.stopWorker();
      fixture.cancelProvisioningAtTeardown(namespace.id, status.agentId);
      const agent = await fixture.request(
        "GET",
        `/namespaces/${namespace.id}/agents/${status.agentId}`,
      );
      assert.deepEqual(agent.data.harnessAuth, body.harnessAuth);
      assert.deepEqual(agent.data.credentialSources, [{ sourceId: source.id }]);
      const revisions = await fixture.state.read((view) =>
        view.revisions.listRevisions(namespace.id, status.agentId),
      );
      assert.equal(revisions.length, 1);
      assert.equal(revisions[0].harness.id, harness);
      assert.deepEqual(revisions[0].credentialSources, [
        {
          sourceId: source.id,
          credentialGatewayId: "credential-gateway-provisioning",
          sourceType: "openai",
        },
      ]);
      const bindings = await fixture.pool.query(
        "SELECT resource_kind, resource_id FROM occ.iam_access_bindings WHERE namespace_id = $1 AND identity_subject_id = $2 ORDER BY resource_kind, resource_id",
        [namespace.id, agent.data.servicePrincipalId],
      );
      assert.deepEqual(bindings.rows, [
        { resource_kind: "credential_source", resource_id: source.id },
      ]);
      assert.equal(
        bindings.rows.some(({ resource_id }) => resource_id === secret.id),
        false,
      );
    },
  );
}

test(
  "guided provisioning rejects Secret model delivery when a Credential Gateway is selected",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const fixture = await createFixture(context, sourceProvisioningDrivers());
    const namespace = await fixture.bootstrapNamespace();
    const secret = await createNamespaceSecret(fixture, namespace.id, "model-key");
    for (const harness of ["openclaw", "codex"]) {
      const body = sourceProvisioningBody("unused-source", harness);
      body.harnessAuth = { method: "api_key", source: secret.ref };
      const refused = await fixture.request(
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        {
          body,
        },
      );
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.match(refused.error.message, /requires credential-source Harness authentication/u);
    }
    const resources = await fixture.pool.query(
      `SELECT
       (SELECT count(*)::integer FROM occ.agent_provisioning_work WHERE namespace_id = $1) AS jobs,
       (SELECT count(*)::integer FROM occ.agents WHERE namespace_id = $1) AS agents,
       (SELECT count(*)::integer FROM occ.configurations WHERE namespace_id = $1) AS configurations`,
      [namespace.id],
    );
    assert.deepEqual(resources.rows[0], { jobs: 0, agents: 0, configurations: 0 });
  },
);

test(
  "guided source provisioning cannot bind an uncertain registration",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const drivers = sourceProvisioningDrivers();
    drivers.credentialGatewayDriver.registerSource = async () => {
      throw new Error("synthetic uncertain credential registration");
    };
    const fixture = await createFixture(context, drivers);
    const namespace = await fixture.bootstrapNamespace();
    const secret = await createNamespaceSecret(fixture, namespace.id, "model-key");
    const registration = await fixture.request(
      "POST",
      `/namespaces/${namespace.id}/credential-sources`,
      {
        body: { name: "uncertain model", type: "openai", secrets: { api_key: secret.ref } },
      },
    );
    assert.equal(registration.status, 503, JSON.stringify(registration.body));
    const sources = await fixture.request("GET", `/namespaces/${namespace.id}/credential-sources`);
    assert.equal(sources.status, 200, JSON.stringify(sources.body));
    assert.equal(sources.data.length, 1);
    assert.equal(sources.data[0].state, "deleting");
    const refused = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body: sourceProvisioningBody(sources.data[0].id, "openclaw"),
    });
    assert.equal(refused.status, 404, JSON.stringify(refused.body));
    const jobs = await fixture.pool.query(
      "SELECT work_id FROM occ.agent_provisioning_work WHERE namespace_id = $1",
      [namespace.id],
    );
    assert.equal(jobs.rowCount, 0);
  },
);

test(
  "guided source provisioning authorizes its source and rechecks ownership before worker effects",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const drivers = sourceProvisioningDrivers();
    const fixture = await createFixture(context, drivers);
    const namespace = await fixture.bootstrapNamespace();
    const { source } = await createProvisioningModelSource(fixture, namespace.id);
    const body = sourceProvisioningBody(source.id, "openclaw");
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    // A selected gateway change cannot reuse another gateway's accepted source.
    const switched = await createFixture(context, {
      ...drivers,
      credentialGatewayDriver: {
        ...drivers.credentialGatewayDriver,
        id: "credential-gateway-replacement",
      },
    });
    const replay = await switched.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(replay.status, 503, JSON.stringify(replay.body));
    const retry = await switched.request("POST", `${admitted.data.provisioning.url}/retry`);
    assert.equal(retry.status, 503, JSON.stringify(retry.body));
    const { workId } = admitted.data.provisioning;
    const ended = (event) => event.event === "worker.completed" && event.workId === workId;
    const events = [];
    const worker = await createFixture(context, {
      ...drivers,
      credentialGatewayDriver: {
        ...drivers.credentialGatewayDriver,
        id: "credential-gateway-replacement",
      },
      onWorkerEvent: (event) => events.push(event),
      // Stop in the pass that ends the first attempt: its retry can be due at once (finding 1610).
      stopWorkerAfter: ended,
    });
    await worker.startWorker();
    await waitFor("the worker to revalidate the source owner", async () => events.find(ended));
    await worker.stopWorker();
    assert.deepEqual(
      events.filter(ended).map(({ attempt, outcome, code }) => ({ attempt, outcome, code })),
      [{ attempt: 1, outcome: "retry", code: "PROVISIONING_DEPENDENCY_UNAVAILABLE" }],
    );
    const row = await provisioningRow(fixture.pool, namespace.id, body.requestId);
    assert.equal(row.completed_phase, "admitted");
    assert.equal(row.agent_id, null);
    assert.equal(row.configuration_id, null);
    const resources = await fixture.pool.query(
      `SELECT
       (SELECT count(*)::integer FROM occ.agents WHERE namespace_id = $1) AS agents,
       (SELECT count(*)::integer FROM occ.configurations WHERE namespace_id = $1) AS configurations,
       (SELECT count(*)::integer FROM occ.agent_revisions WHERE namespace_id = $1) AS revisions`,
      [namespace.id],
    );
    assert.deepEqual(resources.rows[0], { agents: 0, configurations: 0, revisions: 0 });
    // The actor retains provisioning grants but cannot operate this exact source.
    const principalId = await fixture.revokeCurrentPrincipal();
    const roleId = `role-provisioning-${randomUUID()}`;
    const bindingId = `binding-provisioning-${randomUUID()}`;
    await fixture.pool.query(
      "INSERT INTO occ.iam_roles (id, namespace_id, name, permissions) VALUES ($1, NULL, $2, $3::jsonb)",
      [
        roleId,
        `Provisioning without source ${randomUUID()}`,
        JSON.stringify([
          { action: "administer", resourceKind: "installation" },
          { action: "create", resourceKind: "agent" },
          { action: "create", resourceKind: "configuration" },
        ]),
      ],
    );
    await fixture.pool.query(
      "INSERT INTO occ.iam_access_bindings (id, namespace_id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id) VALUES ($1, NULL, $2, NULL, $3, NULL, NULL)",
      [bindingId, principalId, roleId],
    );
    try {
      const denied = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
        body: { ...body, requestId: requestId() },
      });
      assert.equal(denied.status, 403, JSON.stringify(denied.body));
    } finally {
      await fixture.pool.query("DELETE FROM occ.iam_access_bindings WHERE id = $1", [bindingId]);
      await fixture.pool.query("DELETE FROM occ.iam_roles WHERE id = $1", [roleId]);
    }
    const claim = await claimProvisioningWork(fixture.pool, admitted.data.provisioning.workId);
    await fixture.state.transact((unit) =>
      unit.provisioning.cancel(claim, {
        code: "PROVISIONING_CANCELLED",
        message: "source ownership case completed without effects",
      }),
    );
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
    // Until recovery is allowed, the Configuration backend cannot answer the inspection either,
    // so the worker cannot observe the landed write and retries it as an unknown outcome.
    configurationDriver.inspectExact = async (configuration) => {
      if (!allowConfigurationRecovery) {
        throw new Error("synthetic Configuration read outage");
      }
      return inspectExact(configuration);
    };
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
  "a Configuration create that never reached the API server is sent again after its settle window",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const computeDriver = createRuntimeComputeDriver();
    const configurationDriver = createProvisioningConfigurationDriver({
      id: "configuration-provisioning-resend",
    });
    const createExact = configurationDriver.createExact;
    const sent = [];
    configurationDriver.createExact = async (configuration) => {
      sent.push(structuredClone(configuration));
      if (sent.length === 1) {
        // The write deadline passes before the API server receives the create: nothing is
        // stored, and the worker cannot tell that from a create that landed (finding 911).
        throw new Error("synthetic Configuration create timeout before the API server");
      }
      return createExact(configuration);
    };
    const fixture = await createFixture(context, { computeDriver, configurationDriver });
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body: provisioningBody(namespace.id, secrets),
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));

    // Inside the window an absent Configuration may still be a late create, so the worker
    // neither resends it nor spends the fixture's three attempts waiting.
    await provisionUntilConfigurationSettling(fixture, admitted, sent);

    await elapseConfigurationSettleWindow(fixture, admitted.data.provisioning.workId);
    await fixture.startWorker();
    const succeeded = await waitFor("Agent provisioning to succeed after the resend", async () => {
      const observed = await fixture.request("GET", admitted.data.provisioning.url);
      assert.equal(observed.status, 200, JSON.stringify(observed.body));
      assert.notEqual(observed.data.status, "failed", JSON.stringify(observed.body));
      return observed.data.status === "succeeded" ? observed.data : undefined;
    });
    fixture.cancelProvisioningAtTeardown(namespace.id, succeeded.agentId);
    await fixture.stopWorker();

    // The resend writes the same Configuration under the same identity, once.
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1], sent[0]);
    const agent = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/agents/${succeeded.agentId}`,
    );
    assert.equal(agent.status, 200, JSON.stringify(agent.body));
    assert.equal(agent.data.configurationId, sent[0].id);
    assert.deepEqual(
      await configurationDriver.read({ id: sent[0].id, namespaceId: namespace.id }),
      sent[0],
    );
  },
);

test(
  "a resent Configuration create that meets a late original settles only an exact match",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const computeDriver = createRuntimeComputeDriver();
    const configurationDriver = createProvisioningConfigurationDriver({
      id: "configuration-provisioning-resend-conflict",
    });
    const createExact = configurationDriver.createExact;
    const sent = [];
    let lateOriginal;
    configurationDriver.createExact = async (configuration) => {
      sent.push(structuredClone(configuration));
      if (sent.length === 1) {
        throw new Error("synthetic Configuration create timeout");
      }
      // The first create lands just before the resend reaches the API server, which answers
      // that resend and any later one with AlreadyExists, as the Kubernetes Driver reports it.
      if (sent.length === 2) {
        await lateOriginal(configuration);
      }
      throw new ConfigurationConflictError("The Kubernetes ConfigMap create conflicted.");
    };
    const fixture = await createFixture(context, { computeDriver, configurationDriver });
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const provision = async () => {
      const admitted = await fixture.request(
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        {
          body: provisioningBody(namespace.id, secrets, {
            name: `Resend ${randomUUID().slice(0, 8)}`,
          }),
        },
      );
      assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
      return admitted;
    };

    // The late original is the exact Configuration: the conflict proves it landed, and the
    // exact inspection settles it.
    lateOriginal = (configuration) => createExact(configuration);
    const exact = await provision();
    await provisionUntilConfigurationSettling(fixture, exact, sent);
    await elapseConfigurationSettleWindow(fixture, exact.data.provisioning.workId);
    await fixture.startWorker();
    const succeeded = await waitFor("Agent provisioning to settle the late original", async () => {
      const observed = await fixture.request("GET", exact.data.provisioning.url);
      assert.equal(observed.status, 200, JSON.stringify(observed.body));
      assert.notEqual(observed.data.status, "failed", JSON.stringify(observed.body));
      return observed.data.status === "succeeded" ? observed.data : undefined;
    });
    fixture.cancelProvisioningAtTeardown(namespace.id, succeeded.agentId);
    await fixture.stopWorker();
    assert.equal(sent.length, 2);
    assert.deepEqual(
      await configurationDriver.read({ id: sent[0].id, namespaceId: namespace.id }),
      sent[0],
    );

    // A different Configuration under the same name is never taken as this request's write:
    // the work is not settled and runs out of attempts, and the stored document is untouched.
    // (This test Driver's inspection answers not found for a mismatch; the Kubernetes one
    // reports a conflict, which fails the attempt the same way.)
    sent.length = 0;
    const foreign = { model: "foreign-configuration" };
    lateOriginal = (configuration) =>
      configurationDriver.create({ ...configuration, values: foreign });
    const mismatched = await provision();
    await provisionUntilConfigurationSettling(fixture, mismatched, sent);
    await elapseConfigurationSettleWindow(fixture, mismatched.data.provisioning.workId);
    await fixture.startWorker();
    const failed = await waitFor(
      "Agent provisioning to refuse the foreign Configuration",
      async () => {
        const observed = await fixture.request("GET", mismatched.data.provisioning.url);
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        assert.notEqual(observed.data.status, "succeeded", JSON.stringify(observed.body));
        return observed.data.status === "failed" ? observed.data : undefined;
      },
    );
    await fixture.stopWorker();
    assert.equal(failed.error?.code, "PROVISIONING_OUTCOME_UNKNOWN");
    assert.equal(failed.agentId, undefined);
    const stored = await configurationDriver.read({ id: sent[0].id, namespaceId: namespace.id });
    assert.deepEqual(stored.values, foreign);
    const metadata = await fixture.pool.query(
      "SELECT count(*)::integer AS count FROM occ.configurations WHERE namespace_id = $1 AND id = $2",
      [namespace.id, sent[0].id],
    );
    assert.equal(metadata.rows[0].count, 0);
  },
);

test(
  "a Configuration resend follows a fresh authority check and sends nothing once authority is revoked",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const configurationDriver = createProvisioningConfigurationDriver({
      id: "configuration-provisioning-resend-revoked",
    });
    const createExact = configurationDriver.createExact;
    const inspectExact = configurationDriver.inspectExact;
    const sent = [];
    configurationDriver.createExact = async (configuration) => {
      sent.push(structuredClone(configuration));
      if (sent.length === 1) {
        throw new Error("synthetic Configuration create timeout before the API server");
      }
      return createExact(configuration);
    };
    let revokeOnInspection;
    configurationDriver.inspectExact = async (configuration) => {
      const inspected = await inspectExact(configuration);
      await revokeOnInspection?.();
      return inspected;
    };
    const fixture = await createFixture(context, { configurationDriver });
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body: provisioningBody(namespace.id, secrets),
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    const { workId } = admitted.data.provisioning;
    await provisionUntilConfigurationSettling(fixture, admitted, sent);
    await elapseConfigurationSettleWindow(fixture, workId);

    // The actor loses authority after the attempt's first checks passed, while the worker is
    // inspecting the absent Configuration, so only the check just before the resend sees it.
    // Revoked authority must send nothing: the create stays an unknown outcome and the work
    // runs out of attempts.
    let inspections = 0;
    revokeOnInspection = async () => {
      inspections += 1;
      if (inspections === 2) {
        await fixture.revokeCurrentPrincipal();
      }
    };
    await fixture.startWorker();
    const work = await waitFor("the revoked provisioning work to run out of attempts", async () => {
      const observed = await fixture.pool.query(
        "SELECT state, reason_code FROM occ.controller_work WHERE idempotency_key = $1",
        [workId],
      );
      return observed.rows[0]?.state === "failed_permanent" ? observed.rows[0] : undefined;
    });
    await fixture.stopWorker();
    assert.equal(work.reason_code, "PROVISIONING_OUTCOME_UNKNOWN");
    assert.equal(sent.length, 1, "revoked authority must not resend the Configuration create");
    await assert.rejects(
      configurationDriver.read({ id: sent[0].id, namespaceId: namespace.id }),
      /does not exist/,
    );
  },
);

test(
  "provisioning a duplicate Agent name fails permanently, says the name is taken and deletes the Configuration it wrote",
  { ...requiresPostgres, timeout: 120_000 },
  async (context) => {
    const configurationDriver = createProvisioningConfigurationDriver({
      id: "configuration-provisioning-duplicate-name",
    });
    const createExact = configurationDriver.createExact;
    const written = [];
    configurationDriver.createExact = async (configuration) => {
      written.push(configuration.id);
      return createExact(configuration);
    };
    const fixture = await createFixture(context, { configurationDriver });
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

    // The worker wrote the duplicate's Configuration before the Agent insert refused it and
    // rolled back its record. The refusal deletes that unrecorded document (in Kubernetes, a
    // ConfigMap no Configuration answers for; finding 1395) and the job forgets it. The delete
    // runs before the refusal commits, so it is done once the job reads as failed.
    assert.equal(written.length, 2);
    assert.equal(written[0], created.configurationId);
    const rejectedConfiguration = { namespaceId: namespace.id, id: written[1] };
    assert.equal(configurationDriver.stored(rejectedConfiguration), undefined);
    // The delete succeeded, so nothing stays marked for a later attempt to delete either.
    const rejectedRecord = await fixture.pool.query(
      `SELECT completed_phase, configuration_id, progress ? 'pendingEffect' AS pending,
              progress ? 'effectReceipt' AS receipt,
              progress ? 'unrecordedConfigurationId' AS marked
       FROM occ.agent_provisioning_work WHERE work_id = $1`,
      [duplicate.data.provisioning.workId],
    );
    assert.deepEqual(rejectedRecord.rows, [
      {
        completed_phase: "admitted",
        configuration_id: null,
        pending: false,
        receipt: false,
        marked: false,
      },
    ]);

    // Once the name is free, a retry writes a new Configuration instead of trusting a receipt
    // for the deleted one, and provisioning completes with a readable Configuration.
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
    const retried = await fixture.request("POST", `${duplicate.data.provisioning.url}/retry`);
    assert.equal(retried.status, 202, JSON.stringify(retried.body));
    const succeeded = await waitFor("the retried provisioning to succeed", async () => {
      const observed = await fixture.request("GET", duplicate.data.provisioning.url);
      assert.equal(observed.status, 200, JSON.stringify(observed.body));
      assert.notEqual(observed.data.status, "failed", JSON.stringify(observed.body));
      return observed.data.status === "succeeded" ? observed.data : undefined;
    });
    fixture.cancelProvisioningAtTeardown(namespace.id, succeeded.agentId);
    assert.equal(written.length, 3);
    assert.equal(succeeded.configurationId, written[2]);
    assert.notEqual(succeeded.configurationId, rejectedConfiguration.id);
    assert.notEqual(
      configurationDriver.stored({ namespaceId: namespace.id, id: succeeded.configurationId }),
      undefined,
    );
    assert.equal(configurationDriver.stored(rejectedConfiguration), undefined);
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
    const inspectExact = configurationDriver.inspectExact;
    // The outage answers no Configuration request, so the unknown create runs out of attempts.
    configurationDriver.createExact = async (configuration) => {
      if (configurationOutage) {
        throw new Error("synthetic Configuration outage");
      }
      return createExact(configuration);
    };
    configurationDriver.inspectExact = async (configuration) => {
      if (configurationOutage) {
        throw new Error("synthetic Configuration outage");
      }
      return inspectExact(configuration);
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
    const inspectExact = configurationDriver.inspectExact;
    let configurationOutage = true;
    // The outage answers no Configuration request, so the unknown create runs out of attempts.
    configurationDriver.createExact = async (configuration) => {
      if (configurationOutage) {
        throw new Error("synthetic Configuration outage");
      }
      return createExact(configuration);
    };
    configurationDriver.inspectExact = async (configuration) => {
      if (configurationOutage) {
        throw new Error("synthetic Configuration outage");
      }
      return inspectExact(configuration);
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
  "a new dedicated OpenClaw request without a provisioning Sandbox Driver is refused with a 409 naming it",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const fixture = await createFixture(context, {
      computeDriver: createRuntimeComputeDriver(),
      configurationDriver: createProvisioningConfigurationDriver({
        id: "configuration-provisioning-no-sandbox",
      }),
      secretDriver: createTestSecretDriver({ id: "secret-provisioning" }),
    });
    const namespace = await fixture.bootstrapNamespace();
    // The Installation cannot admit dedicated OpenClaw, so it does not report native workers.
    const installation = await fixture.request("GET", "/installation");
    assert.equal(installation.status, 200, JSON.stringify(installation.body));
    assert.equal(installation.data.capabilities?.nativeWorkers, undefined);
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const body = provisioningBody(namespace.id, secrets);
    body.configuration.values.agents.defaults = {
      model: "openai/gpt-5",
      models: { "openai/gpt-5": { agentRuntime: { id: "openclaw" } } },
    };
    // A fixed Installation shape refuses every attempt the same way: a 409 with the reason,
    // not a 503 the Console reads as an unknown outcome (finding 1609).
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const refused = await fixture.request(
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        { body },
      );
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.deepEqual(refused.body.error, {
        code: "RESOURCE_CONFLICT",
        message:
          "Dedicated OpenClaw requires a provisioning SandboxDriver with networking, filesystem, and process containment.",
      });
    }
    // The refusal stored nothing: no provisioning job or Agent.
    assert.deepEqual(await storedProvisioningCounts(fixture.pool, namespace.id), {
      jobs: 0,
      agents: 0,
    });
  },
);

test(
  "OpenShell refuses dedicated OpenClaw at provisioning admission unless user namespaces are off, and status reads still report stored work",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    // Native OpenClaw's private workspace preparation needs kubernetes.userNamespaces: false
    // and runs only after a deploy stopped its predecessors (finding 2334). Provisioning admits
    // the plan through the OpenShell Sandbox view, so a request is refused before it is stored.
    let userNamespaces;
    const fixture = await createFixture(context, {
      computeDriver: createRuntimeComputeDriver(),
      configurationDriver: createProvisioningConfigurationDriver({
        id: "configuration-provisioning-openshell-openclaw",
      }),
      secretDriver: createTestSecretDriver({ id: "secret-provisioning" }),
      sandboxDriver: {
        id: "sandbox-provisioning",
        capability: "sandbox",
        implementation: "openshell",
        facets: ["networking", "filesystem", "process"],
        // OpenShell's own hook on a stand-in holding only the settings it reads, with the
        // userNamespaces value this test changes (as workspace-setup-api does).
        configureAgent(configuration, harness) {
          return OpenShellSandboxDriver.prototype.configureAgent.call(
            {
              options: {
                kubernetes: { userNamespaces, sandboxDataMount: { mountPath: "/sandbox/data" } },
              },
            },
            configuration,
            harness,
          );
        },
        async provisionHarness() {
          assert.fail("this case ends at provisioning handoff");
        },
        async cleanup() {},
      },
    });
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const openClawBody = () => {
      const body = provisioningBody(namespace.id, secrets);
      body.configuration.values.agents.defaults = {
        model: "openai/gpt-5",
        models: { "openai/gpt-5": { agentRuntime: { id: "openclaw" } } },
      };
      return body;
    };
    const provision = (body) =>
      fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, { body });

    const refused = await provision(openClawBody());
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.deepEqual(refused.body.error, {
      code: "INVALID_REQUEST",
      message:
        "Dedicated OpenClaw needs kubernetes.userNamespaces: false in the OpenShell Sandbox Driver configuration. Select Codex, or ask an operator to set it.",
    });
    assert.deepEqual(await storedProvisioningCounts(fixture.pool, namespace.id), {
      jobs: 0,
      agents: 0,
    });

    // Admitted while the setting is off. After an operator turns it back on, a status read
    // still reports the stored work; only writes go through the Sandbox view again.
    userNamespaces = false;
    const admitted = await provision(openClawBody());
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    // No worker runs here; a later test's worker must not run this job with its Drivers.
    fixture.cancelQueuedWorkAtTeardown(
      admitted.data.provisioning.workId,
      "OpenShell admission case ends at the status read",
    );
    userNamespaces = true;
    const status = await fixture.request("GET", admitted.data.provisioning.url);
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(status.data.workId, admitted.data.provisioning.workId);
  },
);

test(
  "losing native Sandbox containment before the worker runs leaves provisioning retryable without effects",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const drivers = {
      computeDriver: createRuntimeComputeDriver(),
      configurationDriver: createProvisioningConfigurationDriver({
        id: "configuration-provisioning-native-containment",
      }),
      secretDriver: createTestSecretDriver({ id: "secret-provisioning" }),
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
    const fixture = await createFixture(context, drivers);
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

    // The selected Driver has lost process containment since admission. The worker must
    // revalidate the complete Sandbox contract before creating any provisioning resources.
    // The retry's jittered backoff can be due at once, so the worker stops in the pass that
    // ends this work's first attempt rather than after the test reads the event (finding 1610).
    const { workId } = admitted.data.provisioning;
    const completed = [];
    const switched = await createFixture(context, {
      ...drivers,
      sandboxDriver: { ...drivers.sandboxDriver, facets: ["networking", "filesystem"] },
      onWorkerEvent: (event) => {
        if (event.event === "worker.completed") {
          completed.push(event);
        }
      },
      stopWorkerAfter: (event) => event.event === "worker.completed" && event.workId === workId,
    });
    await switched.startWorker();
    await waitFor("the worker to finish its first provisioning attempt", async () =>
      completed.find((event) => event.workId === workId),
    );
    await switched.stopWorker();
    assert.deepEqual(
      completed
        .filter((event) => event.workId === workId)
        .map(({ attempt, outcome, code }) => ({ attempt, outcome, code })),
      [{ attempt: 1, outcome: "retry", code: "PROVISIONING_DEPENDENCY_UNAVAILABLE" }],
    );
    const row = await provisioningRow(switched.pool, namespace.id, body.requestId);
    assert.equal(row.status, "running");
    assert.equal(row.completed_phase, "admitted");
    assert.equal(row.agent_id, null);
    assert.equal(row.configuration_id, null);
    assert.equal(row.progress.pendingEffect, undefined);
    assert.deepEqual(row.progress.error, {
      code: "PROVISIONING_DEPENDENCY_UNAVAILABLE",
      message: "Agent provisioning could not complete.",
    });
    const work = await switched.pool.query(
      "SELECT state, reason_code, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
      [admitted.data.provisioning.workId],
    );
    assert.deepEqual(work.rows, [{ state: "queued", reason_code: null, attempt_count: 1 }]);
    const resources = await switched.pool.query(
      `SELECT
       (SELECT count(*)::integer FROM occ.agents WHERE namespace_id = $1) AS agents,
       (SELECT count(*)::integer FROM occ.configurations WHERE namespace_id = $1) AS configurations,
       (SELECT count(*)::integer FROM occ.agent_revisions WHERE namespace_id = $1) AS revisions`,
      [namespace.id],
    );
    assert.deepEqual(resources.rows[0], { agents: 0, configurations: 0, revisions: 0 });
    assert.deepEqual(drivers.computeDriver.calls, []);

    // Status and retry both require the current Sandbox contract. Restoring the complete
    // Driver makes the queued status readable and the existing attempt eligible again.
    const message = "A required platform dependency is unavailable.";
    const status = await switched.request("GET", admitted.data.provisioning.url);
    assert.equal(status.status, 503, JSON.stringify(status.body));
    assert.equal(status.body.error.message, message);
    const retried = await switched.request("POST", `${admitted.data.provisioning.url}/retry`);
    assert.equal(retried.status, 503, JSON.stringify(retried.body));
    assert.equal(retried.body.error.message, message);
    // Replaying the accepted request ID reads the stored work too: the same retryable 503, not
    // the 409 a new request gets for the fixed Installation shape (finding 1614).
    const provisionPath = `/namespaces/${namespace.id}/agents/provision`;
    const replayed = await switched.request("POST", provisionPath, { body });
    assert.equal(replayed.status, 503, JSON.stringify(replayed.body));
    assert.equal(replayed.body.error.message, message);
    const restoredStatus = await fixture.request("GET", admitted.data.provisioning.url);
    assert.equal(restoredStatus.status, 200, JSON.stringify(restoredStatus.body));
    assert.equal(restoredStatus.data.status, "queued");
    assert.equal(restoredStatus.data.attemptCount, 1);
    assert.equal(restoredStatus.data.error, undefined);
    const restoredRetry = await fixture.request("POST", `${admitted.data.provisioning.url}/retry`);
    assert.equal(restoredRetry.status, 202, JSON.stringify(restoredRetry.body));
    assert.equal(restoredRetry.data.workId, admitted.data.provisioning.workId);

    const cleanupClaim = await claimProvisioningWork(
      fixture.pool,
      admitted.data.provisioning.workId,
    );
    await fixture.state.transact((unit) =>
      unit.provisioning.cancel(cleanupClaim, {
        code: "PROVISIONING_CANCELLED",
        message: "containment revalidation test completed without worker dispatch",
      }),
    );
  },
);

test(
  "a Secret Driver switch before the worker runs rejects the provisioning work with the fixed message",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const computeDriver = createRuntimeComputeDriver();
    const configurationDriver = createProvisioningConfigurationDriver({
      id: "configuration-provisioning-secret-switch",
    });
    const fixture = await createFixture(context, {
      computeDriver,
      configurationDriver,
      secretDriver: createTestSecretDriver({ id: "secret-provisioning" }),
    });
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const body = provisioningBody(namespace.id, secrets);
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));

    // The Installation now selects another Secret Driver, which does not own the Secrets the
    // accepted work binds. Every attempt would refuse them the same way, so the worker fails the
    // work on the first one with the fixed message that names the fix, as status and retry do.
    const replacementSecretDriver = createTestSecretDriver({ id: "secret-provisioning-replaced" });
    const switched = await createFixture(context, {
      computeDriver,
      configurationDriver,
      secretDriver: replacementSecretDriver,
    });
    await switched.startWorker();
    const failed = await waitFor(
      "the switched worker to refuse the provisioning work",
      async () => {
        const row = await provisioningRow(switched.pool, namespace.id, body.requestId);
        return row.progress.error === undefined ? undefined : row;
      },
    );
    await switched.stopWorker();
    const message = new ProvisioningSecretDriverError().message;
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.progress.error, { code: "PROVISIONING_REJECTED", message });
    assert.equal(failed.agent_id, null, "the refusal comes before the work creates its Agent");
    const work = await switched.pool.query(
      "SELECT state, reason_code, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
      [admitted.data.provisioning.workId],
    );
    assert.deepEqual(work.rows, [
      { state: "failed_permanent", reason_code: "PROVISIONING_REJECTED", attempt_count: 1 },
    ]);
    const audit = await switched.pool.query(
      `SELECT kind, outcome, details->>'code' AS code
       FROM occ.audit_events
       WHERE namespace_id = $1
         AND action = 'openclaw.agents.provision.failure'
         AND details->>'workId' = $2`,
      [namespace.id, admitted.data.provisioning.workId],
    );
    assert.deepEqual(audit.rows, [
      { kind: "mutation", outcome: "failure", code: "PROVISIONING_REJECTED" },
    ]);
    assert.deepEqual(
      replacementSecretDriver.calls,
      [],
      "the replacement driver never serves a Secret it does not own",
    );

    // Status and retry answer the same fixed message, so Console says the same thing either way.
    const status = await switched.request("GET", admitted.data.provisioning.url);
    assert.equal(status.status, 503, JSON.stringify(status.body));
    assert.equal(status.body.error.message, message);
    const retried = await switched.request("POST", `${admitted.data.provisioning.url}/retry`);
    assert.equal(retried.status, 503, JSON.stringify(retried.body));
    assert.equal(retried.body.error.message, message);
  },
);

test(
  "an unusable Secret Driver leaves the provisioning work retryable",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const secretDriver = createTestSecretDriver({ id: "secret-provisioning" });
    const implementation = secretDriver.implementation;
    let breakSecretDriver = false;
    let workId;
    const completed = [];
    const fixture = await createFixture(context, {
      configurationDriver: createProvisioningConfigurationDriver({
        id: "configuration-provisioning-secret-outage",
      }),
      secretDriver,
      // The worker registers its Drivers at start; changing the selected Secret Driver's
      // identity afterwards makes it unusable to the worker, as an outage would.
      onWorkerEvent: (event) => {
        if (breakSecretDriver && event.event === "worker.started") {
          secretDriver.implementation = `${implementation}-unavailable`;
        }
        if (breakSecretDriver && event.event === "worker.completed") {
          completed.push(event);
        }
      },
      // Stop in the pass that ends the first attempt: its retry can be due at once (finding 1610).
      // workId is unset while bootstrapNamespace runs the worker.
      stopWorkerAfter: (event) =>
        workId !== undefined && event.event === "worker.completed" && event.workId === workId,
    });
    context.after(() => {
      secretDriver.implementation = implementation;
    });
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const body = provisioningBody(namespace.id, secrets);
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));

    // No usable Secret Driver is an outage, not an ownership refusal: the worker keeps the
    // generic message and retries the work.
    breakSecretDriver = true;
    workId = admitted.data.provisioning.workId;
    fixture.cancelQueuedWorkAtTeardown(
      workId,
      "Secret Driver outage test completed after its first attempt",
    );
    await fixture.startWorker();
    await waitFor("the worker to finish its first provisioning attempt", async () =>
      completed.find((event) => event.workId === workId),
    );
    await fixture.stopWorker();
    assert.deepEqual(
      completed
        .filter((event) => event.workId === workId)
        .map(({ attempt, outcome, code }) => ({ attempt, outcome, code })),
      [{ attempt: 1, outcome: "retry", code: "PROVISIONING_DEPENDENCY_UNAVAILABLE" }],
    );
    const work = await fixture.pool.query(
      "SELECT state, reason_code, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
      [workId],
    );
    assert.deepEqual(work.rows, [{ state: "queued", reason_code: null, attempt_count: 1 }]);
    const row = await provisioningRow(fixture.pool, namespace.id, body.requestId);
    assert.deepEqual(row.progress.error, {
      code: "PROVISIONING_DEPENDENCY_UNAVAILABLE",
      message: "Agent provisioning could not complete.",
    });
  },
);

test(
  "a permanent refusal after an unfinished Configuration write settles the write and rejects the work",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const computeDriver = createRuntimeComputeDriver();
    const configurationDriver = createProvisioningConfigurationDriver({
      id: "configuration-provisioning-unsettled-refusal",
    });
    const createExact = configurationDriver.createExact;
    const created = [];
    configurationDriver.createExact = async (configuration) => {
      const stored = await createExact(configuration);
      created.push(configuration.id);
      if (created.length === 1) {
        // The write lands but its receipt is lost, and before the next attempt the
        // Installation's Compute Driver starts refusing the stored plan (no gateway routing).
        const unrouted = createTestKubernetesComputeDriver("compute-provisioning-unrouted", {
          repositoryCredentials: true,
        });
        computeDriver.validateAgentProvisioning = (input) =>
          unrouted.validateAgentProvisioning(input);
        throw new Error("synthetic Configuration receipt loss");
      }
      return stored;
    };
    const completed = [];
    const fixture = await createFixture(context, {
      computeDriver,
      configurationDriver,
      onWorkerEvent: (event) => {
        if (event.event === "worker.completed") {
          completed.push(event);
        }
      },
    });
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const body = provisioningBody(namespace.id, secrets);
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));

    // The next attempt inspects the unfinished write before its fence, records the receipt,
    // and then fails the work on the refusal instead of retrying an unknown outcome. The job
    // never recorded that Configuration, so the refusal deletes it and forgets the write.
    await fixture.startWorker();
    const failed = await waitFor("the provisioning work to fail", async () => {
      const row = await provisioningRow(fixture.pool, namespace.id, body.requestId);
      return row.status === "failed" ? row : undefined;
    });
    await fixture.stopWorker();
    const workId = admitted.data.provisioning.workId;
    assert.deepEqual(
      completed
        .filter((event) => event.workId === workId)
        .map(({ attempt, outcome, code }) => ({ attempt, outcome, code })),
      [
        { attempt: 1, outcome: "retry", code: "PROVISIONING_OUTCOME_UNKNOWN" },
        { attempt: 2, outcome: "permanent", code: "PROVISIONING_REJECTED" },
      ],
    );
    assert.deepEqual(failed.progress.error, {
      code: "PROVISIONING_REJECTED",
      message: "The Compute Driver cannot provision this execution mode or gateway configuration.",
    });
    assert.equal(failed.progress.pendingEffect, undefined);
    assert.equal(failed.progress.effectReceipt, undefined);
    assert.equal(created.length, 1, "recovery never writes the Configuration again");
    assert.equal(
      configurationDriver.stored({ namespaceId: namespace.id, id: created[0] }),
      undefined,
      "the refusal deletes the Configuration the job wrote but never recorded",
    );
    assert.equal(failed.agent_id, null, "the refusal comes before the work creates its Agent");
    const work = await fixture.pool.query(
      "SELECT state, reason_code, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
      [workId],
    );
    assert.deepEqual(work.rows, [
      { state: "failed_permanent", reason_code: "PROVISIONING_REJECTED", attempt_count: 2 },
    ]);
  },
);

test(
  "a refusal whose Configuration delete fails names the orphaned Configuration, and its retry deletes it",
  { ...requiresPostgres, timeout: 90_000 },
  async (context) => {
    const computeDriver = createRuntimeComputeDriver();
    const validateAgentProvisioning = computeDriver.validateAgentProvisioning;
    const configurationDriver = createProvisioningConfigurationDriver({
      id: "configuration-provisioning-delete-outage",
    });
    const createExact = configurationDriver.createExact;
    const created = [];
    configurationDriver.createExact = async (configuration) => {
      const stored = await createExact(configuration);
      created.push(configuration.id);
      if (created.length === 1) {
        // The first write lands, then the Compute Driver starts refusing the stored plan, so
        // the fence of the transaction that would record the Configuration rejects the work.
        const unrouted = createTestKubernetesComputeDriver("compute-provisioning-unrouted", {
          repositoryCredentials: true,
        });
        computeDriver.validateAgentProvisioning = (input) =>
          unrouted.validateAgentProvisioning(input);
      }
      return stored;
    };
    const deleteConfiguration = configurationDriver.delete;
    const deleted = [];
    let deleteOutage = true;
    configurationDriver.delete = async (reference) => {
      if (deleteOutage) {
        throw new Error("synthetic Configuration delete outage");
      }
      deleted.push(reference.id);
      return deleteConfiguration(reference);
    };
    const completed = [];
    const fixture = await createFixture(context, {
      computeDriver,
      configurationDriver,
      onWorkerEvent: (event) => {
        if (event.event === "worker.completed") {
          completed.push(event);
        }
      },
    });
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const body = provisioningBody(namespace.id, secrets);
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    const workId = admitted.data.provisioning.workId;

    await fixture.startWorker();
    await waitFor("the refused provisioning to report its outcome", async () =>
      completed.some((event) => event.workId === workId) ? true : undefined,
    );
    await fixture.stopWorker();

    // The failed delete does not change the refusal: the job still forgets the write, so a
    // retry never trusts it, and the operator log names the document left behind. The job
    // also keeps it marked for deletion, so the leftover is not only a log line (finding 1399).
    // The line is the one the worker log keeps (finding 2245).
    assert.equal(created.length, 1);
    assert.deepEqual(
      completed
        .filter((event) => event.workId === workId)
        .map(occLogLine)
        .map(({ outcome, code, orphanedConfigurationId }) => ({
          outcome,
          code,
          orphanedConfigurationId,
        })),
      [
        {
          outcome: "permanent",
          code: "PROVISIONING_REJECTED",
          orphanedConfigurationId: created[0],
        },
      ],
    );
    const failed = await provisioningRow(fixture.pool, namespace.id, body.requestId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.completed_phase, "admitted");
    assert.equal(failed.progress.error?.code, "PROVISIONING_REJECTED");
    assert.equal(failed.progress.pendingEffect, undefined);
    assert.equal(failed.progress.effectReceipt, undefined);
    assert.equal(failed.progress.unrecordedConfigurationId, created[0]);
    const orphaned = { namespaceId: namespace.id, id: created[0] };
    assert.notEqual(configurationDriver.stored(orphaned), undefined);
    const work = await fixture.pool.query(
      "SELECT state, reason_code, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
      [workId],
    );
    assert.deepEqual(work.rows, [
      { state: "failed_permanent", reason_code: "PROVISIONING_REJECTED", attempt_count: 1 },
    ]);

    // Once the Driver can delete again and the plan is accepted again, the retry deletes the
    // marked Configuration before it writes a new one, and provisioning completes.
    deleteOutage = false;
    computeDriver.validateAgentProvisioning = validateAgentProvisioning;
    const retried = await fixture.request("POST", `${admitted.data.provisioning.url}/retry`);
    assert.equal(retried.status, 202, JSON.stringify(retried.body));
    await fixture.startWorker();
    const succeeded = await waitFor("the retried provisioning to succeed", async () => {
      const observed = await fixture.request("GET", admitted.data.provisioning.url);
      assert.equal(observed.status, 200, JSON.stringify(observed.body));
      assert.notEqual(observed.data.status, "failed", JSON.stringify(observed.body));
      return observed.data.status === "succeeded" ? observed.data : undefined;
    });
    fixture.cancelProvisioningAtTeardown(namespace.id, succeeded.agentId);
    assert.deepEqual(deleted, [created[0]]);
    assert.equal(configurationDriver.stored(orphaned), undefined);
    assert.equal(created.length, 2);
    assert.equal(succeeded.configurationId, created[1]);
    assert.notEqual(
      configurationDriver.stored({ namespaceId: namespace.id, id: succeeded.configurationId }),
      undefined,
    );
    const retriedRow = await provisioningRow(fixture.pool, namespace.id, body.requestId);
    assert.equal(retriedRow.progress.unrecordedConfigurationId, undefined);
  },
);

test(
  "the Configuration a refusal could not delete before losing its claim is deleted by the next refusing attempt",
  { ...requiresPostgres, timeout: 90_000 },
  async (context) => {
    const computeDriver = createRuntimeComputeDriver();
    const configurationDriver = createProvisioningConfigurationDriver({
      id: "configuration-provisioning-delete-claim-lost",
    });
    const createExact = configurationDriver.createExact;
    const created = [];
    configurationDriver.createExact = async (configuration) => {
      const stored = await createExact(configuration);
      created.push(configuration.id);
      // The write lands, then the Compute Driver refuses the stored plan for good, so this
      // attempt's fence and every later one reject the work, and `/retry` would refuse too.
      const unrouted = createTestKubernetesComputeDriver("compute-provisioning-unrouted", {
        repositoryCredentials: true,
      });
      computeDriver.validateAgentProvisioning = (input) =>
        unrouted.validateAgentProvisioning(input);
      return stored;
    };
    let fixture;
    let workId;
    const deleteConfiguration = configurationDriver.delete;
    const deleted = [];
    let stalled = false;
    configurationDriver.delete = async (reference) => {
      if (!stalled) {
        // The worker stalls before its delete until its database lease has run out, as a
        // stopped or partitioned worker would, and the delete never reaches the Driver.
        stalled = true;
        await expireWorkLease(fixture.pool, { key: workId, state: "claimed" });
        throw new Error("synthetic worker stall before the Configuration delete");
      }
      deleted.push(reference.id);
      return deleteConfiguration(reference);
    };
    const completed = [];
    fixture = await createFixture(context, {
      computeDriver,
      configurationDriver,
      onWorkerEvent: (event) => {
        if (event.event === "worker.completed") {
          completed.push(event);
        }
      },
    });
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const body = provisioningBody(namespace.id, secrets);
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    workId = admitted.data.provisioning.workId;

    // The stalled attempt cannot record its refusal. Recovery requeues the job, which still
    // names the write only through its mark, and the next attempt's fence refuses it again.
    // That refusal deletes the marked document, then forgets the mark (finding 1399).
    await fixture.startWorker();
    try {
      await waitFor(
        "the requeued attempt to refuse the work",
        async () => (completed.some((event) => event.workId === workId) ? true : undefined),
        30_000,
      );
    } finally {
      await fixture.stopWorker();
    }
    assert.equal(stalled, true);
    assert.equal(created.length, 1, "no attempt writes the Configuration again");
    assert.deepEqual(deleted, [created[0]]);
    assert.equal(
      configurationDriver.stored({ namespaceId: namespace.id, id: created[0] }),
      undefined,
    );
    assert.deepEqual(
      completed
        .filter((event) => event.workId === workId)
        .map(({ outcome, code, orphanedConfigurationId }) => ({
          outcome,
          code,
          orphanedConfigurationId,
        })),
      [{ outcome: "permanent", code: "PROVISIONING_REJECTED", orphanedConfigurationId: undefined }],
    );
    const failed = await provisioningRow(fixture.pool, namespace.id, body.requestId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.progress.error?.code, "PROVISIONING_REJECTED");
    assert.equal(failed.progress.pendingEffect, undefined);
    assert.equal(failed.progress.effectReceipt, undefined);
    assert.equal(failed.progress.unrecordedConfigurationId, undefined);
  },
);

test(
  "a lost authority after an unfinished transport write settles the write and rejects the work",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    let fixture;
    const computeDriver = createRuntimeComputeDriver();
    const provisionRuntimeCredentials = computeDriver.provisionAgentRuntimeCredentials;
    let provisioned = 0;
    computeDriver.provisionAgentRuntimeCredentials = async (...args) => {
      const status = await provisionRuntimeCredentials(...args);
      provisioned += 1;
      if (provisioned === 1) {
        // The credentials land but their receipt is lost, and the initiating administrator
        // loses the provisioning grants before the next attempt.
        await fixture.revokeCurrentPrincipal();
        throw new Error("synthetic transport receipt loss");
      }
      return status;
    };
    const completed = [];
    fixture = await createFixture(context, {
      computeDriver,
      onWorkerEvent: (event) => {
        if (event.event === "worker.completed") {
          completed.push(event);
        }
      },
    });
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const body = provisioningBody(namespace.id, secrets);
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));

    await fixture.startWorker();
    const failed = await waitFor("the provisioning work to fail", async () => {
      const row = await provisioningRow(fixture.pool, namespace.id, body.requestId);
      return row.status === "failed" ? row : undefined;
    });
    await fixture.stopWorker();
    fixture.cancelProvisioningAtTeardown(namespace.id, failed.agent_id);
    const workId = admitted.data.provisioning.workId;
    assert.deepEqual(
      completed
        .filter((event) => event.workId === workId)
        .map(({ attempt, outcome, code }) => ({ attempt, outcome, code })),
      [
        { attempt: 1, outcome: "retry", code: "PROVISIONING_OUTCOME_UNKNOWN" },
        { attempt: 2, outcome: "permanent", code: "PROVISIONING_REJECTED" },
      ],
    );
    assert.equal(failed.progress.error?.code, "PROVISIONING_REJECTED");
    const { pendingEffect, effectReceipt } = failed.progress;
    assert.deepEqual(
      { kind: effectReceipt?.kind, owner: effectReceipt?.owner, targetId: effectReceipt?.targetId },
      { kind: "transport", owner: pendingEffect?.owner, targetId: failed.agent_id },
    );
    assert.equal(provisioned, 1, "recovery never provisions the credentials again");
    const work = await fixture.pool.query(
      "SELECT state, reason_code, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
      [workId],
    );
    assert.deepEqual(work.rows, [
      { state: "failed_permanent", reason_code: "PROVISIONING_REJECTED", attempt_count: 2 },
    ]);
    // One failure audit per attempt: the unknown outcome, then the authorization denial.
    const audit = await fixture.pool.query(
      `SELECT kind, outcome FROM occ.audit_events
       WHERE namespace_id = $1
         AND action = 'openclaw.agents.provision.failure'
         AND details->>'workId' = $2
       ORDER BY kind`,
      [namespace.id, workId],
    );
    assert.deepEqual(audit.rows, [
      { kind: "authorization_denial", outcome: "denied" },
      { kind: "mutation", outcome: "failure" },
    ]);
    const revisions = await fixture.pool.query(
      "SELECT id FROM occ.agent_revisions WHERE namespace_id = $1",
      [namespace.id],
    );
    assert.equal(revisions.rowCount, 0);
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
    // This Installation has no ChatGPT Backend, so the failure names it instead of the
    // generic text.
    const job = await fixture.pool.query(
      "SELECT progress->'error' AS error FROM occ.agent_provisioning_work WHERE work_id = $1",
      [workId],
    );
    assert.deepEqual(job.rows, [
      {
        error: {
          code: "PROVISIONING_REJECTED",
          message: new ServiceAccountDriverNotConfiguredError("deploy").message,
        },
      },
    ]);
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
  "a pending provisioning request is named as a Secret consumer only while its actor may read its ServiceAccount",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const fixture = await createFixture(context);
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const created = await fixture.request("POST", `/namespaces/${namespace.id}/service-accounts`, {
      body: { name: `consumer-account-${randomUUID().slice(0, 8)}` },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const account = created.data;
    // Admission needs a Backend-issued account, which this fixture cannot issue, so the plan is
    // stored directly (as above). No worker runs: it stays queued and keeps referencing its Secrets.
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
    const secretPath = `/namespaces/${namespace.id}/secrets/${secrets.slackBotToken.id}`;
    const consumers = async () => {
      const read = await fixture.request("GET", secretPath);
      assert.equal(read.status, 200, JSON.stringify(read.body));
      return read.data.consumers;
    };
    assert.deepEqual((await consumers()).provisioningRequests, [workId]);

    // The status read checks the plan's account read; once denied, the request is only counted.
    await fixture.pool.query(
      `INSERT INTO occ.iam_restrictions (id, namespace_id, action, resource_kind, resource_id)
       VALUES ($1, $2, 'read', 'service_account', $3)`,
      [`restriction_${randomUUID()}`, namespace.id, account.id],
    );
    const hidden = await consumers();
    assert.deepEqual(hidden.provisioningRequests, []);
    assert.equal(hidden.unreadable, 1);
    assert.doesNotMatch(JSON.stringify(hidden), new RegExp(workId));
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
  "a Namespace is deletable after a refused provisioning wrote and deleted its Configuration",
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
      // refusal deleted that write and the job forgot it, so nothing remains in flight.
      const failed = await fixture.pool.query(
        `SELECT status, completed_phase, progress ? 'pendingEffect' AS pending,
                progress ? 'effectReceipt' AS receipt
         FROM occ.agent_provisioning_work WHERE work_id = $1`,
        [duplicate.data.provisioning.workId],
      );
      assert.deepEqual(failed.rows, [
        { status: "failed", completed_phase: "admitted", pending: false, receipt: false },
      ]);

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
    // The status names the Stop: the stopped Agent keeps its name, so it must not say to
    // create a new Agent (finding 1376).
    assert.equal(
      stoppedProvisioning.data.error?.message,
      "Provisioning was cancelled because the Agent was stopped.",
    );

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
    assert.equal(
      deletedProvisioning.data.error?.message,
      "Provisioning was cancelled because the Agent was deleted.",
    );

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

// Holds the worker inside its first runtime-credential write until `hold` returns (the write then
// stores the credentials) or throws (it ends without storing them). Later calls, such as deploy
// admission creating missing credentials, run at once.
function heldTransportDriver(hold) {
  const computeDriver = createRuntimeComputeDriver();
  const provisionRuntimeCredentials = computeDriver.provisionAgentRuntimeCredentials;
  let first = true;
  computeDriver.provisionAgentRuntimeCredentials = async (...args) => {
    if (first) {
      first = false;
      await hold();
    }
    return provisionRuntimeCredentials(...args);
  };
  return computeDriver;
}

// Admits provisioning and starts the worker, then waits until it is inside its first runtime
// credential write, so a worker holds the job's claim with a pending transport effect.
async function provisionUntilTransportWrite(fixture, isWriting) {
  const namespace = await fixture.bootstrapNamespace();
  const secrets = await createProvisioningSecrets(fixture, namespace.id);
  const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
    body: provisioningBody(namespace.id, secrets),
  });
  assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
  await fixture.startWorker();
  await waitFor("the worker to begin the runtime-credential write", async () =>
    isWriting() ? true : undefined,
  );
  const pending = await fixture.pool.query(
    `SELECT agent_id, status, progress -> 'pendingEffect' AS pending_effect
     FROM occ.agent_provisioning_work WHERE work_id = $1`,
    [admitted.data.provisioning.workId],
  );
  assert.equal(pending.rowCount, 1);
  assert.equal(pending.rows[0].status, "running");
  assert.equal(pending.rows[0].pending_effect?.kind, "transport");
  assert.equal(pending.rows[0].pending_effect?.targetId, pending.rows[0].agent_id);
  return {
    namespace,
    admitted,
    agentId: pending.rows[0].agent_id,
    pendingEffect: pending.rows[0].pending_effect,
  };
}

async function provisioningEffectState(pool, workId) {
  const result = await pool.query(
    `SELECT status, revision_id, completed_phase, progress -> 'effectReceipt' AS receipt
     FROM occ.agent_provisioning_work WHERE work_id = $1`,
    [workId],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

const cancelledWriteMessage =
  "The Agent's cancelled provisioning may still be writing its runtime credentials. Try again in a few seconds, or delete the Agent.";

test(
  "Stop during an interrupted runtime-credential write lets the Agent deploy once the claim's lease ends",
  { ...requiresPostgres, timeout: 90_000 },
  async (context) => {
    let writing = false;
    let interrupted = false;
    // The write ends only when the worker aborts it: after Stop its heartbeat finds the claim
    // gone. Like a crash or an exhausted unknown outcome, it never confirms, so no receipt exists.
    const computeDriver = heldTransportDriver(async () => {
      writing = true;
      const signal = currentComputeAbortSignal();
      assert.ok(signal, "the worker must run the write under its claim's abort signal");
      if (!signal.aborted) {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      }
      interrupted = true;
      throw new Error("synthetic runtime-credential write interrupted by claim loss");
    });
    const fixture = await createFixture(context, { computeDriver, leaseDurationMs: 3_000 });
    let target;
    let agentPath;
    try {
      target = await provisionUntilTransportWrite(fixture, () => writing);
      agentPath = `/namespaces/${target.namespace.id}/agents/${target.agentId}`;
      const stopped = await fixture.request("POST", `${agentPath}/stop`);
      assert.equal(stopped.status, 202, JSON.stringify(stopped.body));

      // Until the cancelled claim's lease runs out its write may still land, so Deploy is
      // refused. The text says to wait or delete: a cancelled job cannot be retried.
      const early = await fixture.request("POST", `${agentPath}/deploy`);
      assert.equal(early.status, 409, JSON.stringify(early.body));
      assert.equal(early.body.error.message, cancelledWriteMessage);
      await waitFor("the worker to abort the write after losing its claim", async () =>
        interrupted ? true : undefined,
      );
    } finally {
      await fixture.stopWorker();
    }
    const { workId, url } = target.admitted.data.provisioning;
    assert.equal((await provisioningEffectState(fixture.pool, workId)).receipt, null);

    // Nothing else will settle the write (finding 1384). Once the lease has passed, Deploy
    // settles it itself and admits the first revision, with no worker and no manual repair.
    const deployed = await waitFor(
      "Deploy to settle the abandoned write after the claim's lease",
      async () => {
        const attempt = await fixture.request("POST", `${agentPath}/deploy`);
        if (attempt.status === 409) {
          assert.equal(attempt.body.error.message, cancelledWriteMessage);
          return undefined;
        }
        return attempt;
      },
      20_000,
    );
    assert.equal(deployed.status, 202, JSON.stringify(deployed.body));
    assert.equal(deployed.data.id?.startsWith("rev_"), true);
    fixture.cancelProvisioningAtTeardown(target.namespace.id, target.agentId);

    // The interrupted write stored nothing; deploy admission created the runtime credentials.
    assert.equal(
      computeDriver.calls.filter(
        ({ operation, agentId }) =>
          operation === "provisionAgentRuntimeCredentials" && agentId === target.agentId,
      ).length,
      1,
    );
    assert.deepEqual(
      await computeDriver.getAgentRuntimeCredentialStatus({
        namespace: { id: target.namespace.id },
        agent: { id: target.agentId },
      }),
      { transportConfigured: true },
    );
    // The job stays cancelled and never hands off; its receipt names the exact abandoned write.
    const settled = await provisioningEffectState(fixture.pool, workId);
    assert.equal(settled.status, "cancelled");
    assert.equal(settled.revision_id, null);
    assert.deepEqual(settled.receipt, {
      kind: "transport",
      owner: target.pendingEffect.owner,
      targetId: target.agentId,
    });
    const status = await fixture.request("GET", url);
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(status.data.status, "failed");
    assert.equal(status.data.error?.code, "PROVISIONING_CANCELLED");
  },
);

test(
  "Stop after failed provisioning left its runtime-credential write unsettled lets the Agent deploy",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    let reportStoredCredentials = false;
    // The default 30 s lease: no wait is needed, because no worker held the failed job's claim.
    const fixture = await createFixture(context, {
      computeDriver: failingTransportDriver(() => reportStoredCredentials),
    });
    const target = await createFailedPreHandoffAgent(fixture);
    const agentPath = `/namespaces/${target.namespace.id}/agents/${target.failed.agentId}`;
    const stopped = await fixture.request("POST", `${agentPath}/stop`);
    assert.equal(stopped.status, 202, JSON.stringify(stopped.body));

    // Every attempt's write had ended before the job failed, so Deploy settles the pending
    // write at once instead of refusing with 409 forever (finding 1384). The failed write had
    // stored the credentials, and deploy admission now observes them.
    reportStoredCredentials = true;
    const deployed = await fixture.request("POST", `${agentPath}/deploy`);
    assert.equal(deployed.status, 202, JSON.stringify(deployed.body));
    assert.equal(deployed.data.id?.startsWith("rev_"), true);
    fixture.cancelProvisioningAtTeardown(target.namespace.id, target.failed.agentId);
    const settled = await provisioningEffectState(
      fixture.pool,
      target.admitted.data.provisioning.workId,
    );
    assert.equal(settled.status, "cancelled");
    assert.equal(settled.revision_id, null);
    assert.deepEqual(settled.receipt, {
      kind: "transport",
      owner: target.pendingEffect.owner,
      targetId: target.failed.agentId,
    });
  },
);

test(
  "Stop before admission cancels provisioning while a worker holds its claim, and a Deploy right after waits for the write",
  { ...requiresPostgres, timeout: 90_000 },
  async (context) => {
    let writing = false;
    let releaseWrite;
    const writeReleased = new Promise((resolve) => {
      releaseWrite = resolve;
    });
    const computeDriver = heldTransportDriver(async () => {
      writing = true;
      await writeReleased;
    });
    // The default 30 s lease keeps the cancelled claim's write window open for the whole test.
    const fixture = await createFixture(context, { computeDriver });
    let target;
    let revisionId;
    try {
      target = await provisionUntilTransportWrite(fixture, () => writing);
      const { workId, url } = target.admitted.data.provisioning;
      const agentPath = `/namespaces/${target.namespace.id}/agents/${target.agentId}`;
      const stopped = await fixture.request("POST", `${agentPath}/stop`);
      assert.equal(stopped.status, 202, JSON.stringify(stopped.body));
      assert.equal(stopped.data.desiredRuntimeState, "stopped");
      // Stop cancels the job at once, though the worker is still inside its attempt.
      const cancelled = await fixture.request("GET", url);
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
      assert.equal(cancelled.data.status, "failed");
      assert.equal(cancelled.data.error?.code, "PROVISIONING_CANCELLED");
      assert.equal(cancelled.data.revisionId, undefined);

      // A Deploy right after the Stop, while the live worker's write is in flight, is refused:
      // the write's outcome is still unknown.
      const early = await fixture.request("POST", `${agentPath}/deploy`);
      assert.equal(early.status, 409, JSON.stringify(early.body));

      // The write completes and records its receipt without the claim. The worker's next
      // fence then fails, so it cannot hand off a deployment for the stopped Agent.
      releaseWrite();
      await waitFor("the late write to record its receipt", async () => {
        const state = await provisioningEffectState(fixture.pool, workId);
        return state.receipt === null ? undefined : state;
      });
      const deployed = await fixture.request("POST", `${agentPath}/deploy`);
      assert.equal(deployed.status, 202, JSON.stringify(deployed.body));
      revisionId = deployed.data.id;
      fixture.cancelProvisioningAtTeardown(target.namespace.id, target.agentId);
    } finally {
      releaseWrite();
      // Waits for the worker's pass, so its stale attempt has ended before the checks below.
      await fixture.stopWorker();
    }

    // The owner's Deploy admitted the only revision; the cancelled job never reached handoff.
    const revisions = await fixture.state.read((view) =>
      view.revisions.listRevisions(target.namespace.id, target.agentId),
    );
    assert.deepEqual(
      revisions.map(({ id }) => id),
      [revisionId],
    );
    const job = await provisioningEffectState(
      fixture.pool,
      target.admitted.data.provisioning.workId,
    );
    assert.equal(job.status, "cancelled");
    assert.equal(job.revision_id, null);
    assert.equal(job.completed_phase, "configuration");
    // The late write stored the credentials, so deploy admission did not write them again.
    assert.equal(
      computeDriver.calls.filter(
        ({ operation, agentId }) =>
          operation === "provisionAgentRuntimeCredentials" && agentId === target.agentId,
      ).length,
      1,
    );
  },
);

test(
  "Delete after the first deployment's admission waits for provisioning to finish, then removes it",
  { ...requiresPostgres, timeout: 90_000 },
  async (context) => {
    let firstRevisionId;
    const computeDriver = createRuntimeComputeDriver();
    const prepareRevision = computeDriver.prepareRevision.bind(computeDriver);
    // Keep the first revision unready, so provisioning is still watching it when Delete arrives.
    computeDriver.prepareRevision = async (revision, operationContext) => ({
      ...(await prepareRevision(revision, operationContext)),
      ready: firstRevisionId !== undefined && revision.id !== firstRevisionId,
    });
    const fixture = await createFixture(context, { computeDriver });
    const namespace = await fixture.bootstrapNamespace();
    const secrets = await createProvisioningSecrets(fixture, namespace.id);
    const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
      body: provisioningBody(namespace.id, secrets),
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    const { workId, url } = admitted.data.provisioning;
    let handoff;
    await fixture.startWorker();
    try {
      handoff = await waitFor("the first deployment to be admitted", async () => {
        const observed = await fixture.request("GET", url);
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        return observed.data.revisionId !== undefined ? observed.data : undefined;
      });
      firstRevisionId = handoff.revisionId;
      const agentPath = `/namespaces/${namespace.id}/agents/${handoff.agentId}`;
      const deleting = await fixture.request("DELETE", agentPath);
      assert.equal(deleting.status, 202, JSON.stringify(deleting.body));
      assert.equal(deleting.data.status, "deleting");

      // Deletion stops the first rollout. The deletion finalizer refuses while the job is still
      // running, so the Agent goes away only after provisioning records its own outcome.
      await waitFor(
        "the Agent deletion to finish",
        async () => {
          const observed = await fixture.request("GET", agentPath);
          if (observed.status === 404) {
            return true;
          }
          assert.equal(observed.status, 200, JSON.stringify(observed.body));
          assert.equal(observed.data.status, "deleting");
          return undefined;
        },
        45_000,
      );
    } finally {
      await fixture.stopWorker();
    }

    // The job recorded the stopped rollout's outcome. Its failure audit commits only with the
    // job's own row, so the job finished before deletion removed it with the Agent.
    const outcomes = await fixture.pool.query(
      `SELECT action, details->>'code' AS code, details->>'reasonCode' AS reason_code
       FROM occ.audit_events
       WHERE namespace_id = $1
         AND (
           (action = 'openclaw.agents.provision.failure' AND details->>'workId' = $2)
           OR (
             action = 'openclaw.agents.lifecycle.delete'
             AND resource_id = $3
             AND outcome = 'success'
           )
         )
       ORDER BY action`,
      [namespace.id, workId, handoff.agentId],
    );
    assert.deepEqual(
      outcomes.rows.map(({ action, code, reason_code: reasonCode }) => [
        action,
        code ?? reasonCode,
      ]),
      [
        ["openclaw.agents.lifecycle.delete", "AGENT_DELETED"],
        ["openclaw.agents.provision.failure", "REVISION_STOPPED"],
      ],
    );
    const remaining = await fixture.pool.query(
      `SELECT
         (SELECT count(*) FROM occ.agent_provisioning_work WHERE work_id = $1)::int AS jobs,
         (SELECT count(*) FROM occ.controller_work WHERE idempotency_key = $1)::int AS work,
         (SELECT count(*) FROM occ.agent_revisions
           WHERE namespace_id = $2 AND agent_id = $3)::int AS revisions`,
      [workId, namespace.id, handoff.agentId],
    );
    assert.deepEqual(remaining.rows, [{ jobs: 0, work: 0, revisions: 0 }]);
    assert.equal(
      computeDriver.calls.some(
        ({ operation, agentId }) =>
          operation === "deleteAgentRuntimeCredentials" && agentId === handoff.agentId,
      ),
      true,
    );
  },
);

async function admitProvisioning(fixture) {
  const namespace = await fixture.bootstrapNamespace();
  const secrets = await createProvisioningSecrets(fixture, namespace.id);
  const admitted = await fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
    body: provisioningBody(namespace.id, secrets),
  });
  assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
  return {
    namespace,
    workId: admitted.data.provisioning.workId,
    url: admitted.data.provisioning.url,
  };
}

async function provisioningJob(pool, workId) {
  const result = await pool.query(
    `SELECT provisioning.agent_id, provisioning.status, provisioning.completed_phase,
            provisioning.revision_id, work.state AS work_state, work.reason_code
     FROM occ.agent_provisioning_work AS provisioning
     JOIN occ.controller_work AS work ON work.idempotency_key = provisioning.work_id
     WHERE provisioning.work_id = $1`,
    [workId],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

async function handoffCheckpoints(pool, workId) {
  const result = await pool.query(
    `SELECT 1 FROM occ.audit_events
     WHERE action = 'openclaw.agents.provision.checkpoint'
       AND details->>'workId' = $1
       AND details->>'phase' = 'handoff'`,
    [workId],
  );
  return result.rowCount;
}

test(
  "a provisioning handoff that takes the Namespace lock before Stop admits its deployment, which Stop then ends",
  { ...requiresPostgres, timeout: 90_000 },
  async (context) => {
    let target;
    let handoffPid;
    let admitting = false;
    let releaseAdmission;
    const admissionReleased = new Promise((resolve) => {
      releaseAdmission = resolve;
    });
    const computeDriver = createRuntimeComputeDriver();
    const prepareRevision = computeDriver.prepareRevision.bind(computeDriver);
    // The first deployment never becomes ready, so only the Stop can end it.
    computeDriver.prepareRevision = async (revision, operationContext) => ({
      ...(await prepareRevision(revision, operationContext)),
      ready: false,
    });
    // The handoff's deploy admission checks the runtime credentials while its transaction holds
    // the Namespace and Agent locks. Holding that check holds the handoff with its locks.
    const getRuntimeCredentialStatus = computeDriver.getAgentRuntimeCredentialStatus;
    computeDriver.getAgentRuntimeCredentialStatus = async (binding) => {
      if (!admitting && binding.namespace.id === target?.namespace.id) {
        admitting = true;
        await admissionReleased;
      }
      return getRuntimeCredentialStatus(binding);
    };
    const fixture = await createFixture(context, {
      computeDriver,
      // The worker is serial, so its latest Namespace lock is the held handoff's own.
      beforeWorkerStatement: (statement, values, backendPid) => {
        if (
          target !== undefined &&
          values?.[0] === target.namespace.id &&
          namespaceLockStatement.test(statement)
        ) {
          handoffPid = backendPid;
        }
      },
    });
    target = await admitProvisioning(fixture);
    const { namespace, workId, url } = target;
    let stopping;
    await fixture.startWorker();
    try {
      await waitFor("the handoff to hold its deploy admission", async () =>
        admitting ? true : undefined,
      );
      assert.ok(handoffPid, "the handoff must have taken the Namespace lock");
      const job = await provisioningJob(fixture.pool, workId);
      assert.equal(job.completed_phase, "transport");
      assert.equal(job.revision_id, null);
      fixture.cancelProvisioningAtTeardown(namespace.id, job.agent_id);
      const agentPath = `/namespaces/${namespace.id}/agents/${job.agent_id}`;
      stopping = fixture.request("POST", `${agentPath}/stop`);
      // Surface an early failure through the await below instead of an unhandled rejection.
      stopping.catch(() => {});
      await waitForLockWaiter(
        fixture.pool,
        handoffPid,
        "Stop to wait on the handoff's Namespace lock",
      );
      releaseAdmission();
      const stopped = await stopping;
      assert.equal(stopped.status, 202, JSON.stringify(stopped.body));
      assert.equal(stopped.data.desiredRuntimeState, "stopped");

      // The handoff committed first, so Stop's cancellation skipped the job, which now has a
      // revision. Stop ends that first deployment instead, and the job records the outcome.
      const settled = await waitFor(
        "initial provisioning to settle",
        async () => {
          const observed = await fixture.request("GET", url);
          assert.equal(observed.status, 200, JSON.stringify(observed.body));
          return ["succeeded", "failed"].includes(observed.data.status) ? observed.data : undefined;
        },
        30_000,
      );
      assert.equal(settled.status, "failed", JSON.stringify(settled));
      assert.equal(settled.agentId, job.agent_id);
      assert.equal(settled.revisionId?.startsWith("rev_"), true, JSON.stringify(settled));
      assert.deepEqual(settled.error, {
        code: "REVISION_STOPPED",
        message: "The Agent was stopped before its first deployment finished.",
      });
      const first = await fixture.request("GET", `${agentPath}/deployments/${settled.revisionId}`);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.data.error?.code, "REVISION_STOPPED");
      const finished = await provisioningJob(fixture.pool, workId);
      assert.deepEqual(
        [finished.status, finished.revision_id, finished.work_state, finished.reason_code],
        ["failed", settled.revisionId, "failed_permanent", "REVISION_STOPPED"],
      );
      assert.equal(await handoffCheckpoints(fixture.pool, workId), 1);
      const revisions = await fixture.state.read((view) =>
        view.revisions.listRevisions(namespace.id, job.agent_id),
      );
      assert.deepEqual(
        revisions.map(({ id }) => id),
        [settled.revisionId],
      );
    } finally {
      releaseAdmission();
      await stopping?.catch(() => {});
      await fixture.stopWorker();
    }
  },
);

test(
  "Stop that takes the Namespace lock before a waiting provisioning handoff rolls the whole handoff back",
  { ...requiresPostgres, timeout: 90_000 },
  async (context) => {
    let fixture;
    let target;
    let handoffPid;
    let releaseHandoff;
    const handoffReleased = new Promise((resolve) => {
      releaseHandoff = resolve;
    });
    const events = [];
    fixture = await createFixture(context, {
      onWorkerEvent: (event) => events.push(event),
      // Pause the handoff transaction just before it locks the Namespace: the first attempt's
      // first Namespace lock once the transport checkpoint has committed. By then the
      // transaction has already read the job as running.
      beforeWorkerStatement: async (statement, values, backendPid) => {
        if (
          handoffPid !== undefined ||
          target === undefined ||
          values?.[0] !== target.namespace.id ||
          !namespaceLockStatement.test(statement) ||
          events.some(
            (event) => event.event === "worker.completed" && event.workId === target.workId,
          )
        ) {
          return;
        }
        const job = await fixture.pool.query(
          "SELECT completed_phase FROM occ.agent_provisioning_work WHERE work_id = $1",
          [target.workId],
        );
        if (job.rows[0]?.completed_phase !== "transport") {
          return;
        }
        handoffPid = backendPid;
        await handoffReleased;
      },
    });
    target = await admitProvisioning(fixture);
    const { namespace, workId, url } = target;
    let stopping;
    await fixture.startWorker();
    try {
      await waitFor("the handoff to reach its Namespace lock", async () => handoffPid);
      const job = await provisioningJob(fixture.pool, workId);
      assert.deepEqual(
        [job.status, job.completed_phase, job.revision_id],
        ["running", "transport", null],
      );
      const agentPath = `/namespaces/${namespace.id}/agents/${job.agent_id}`;
      // A lock held from a test connection orders the two waiters: Stop queues first, then the
      // handoff. PostgreSQL grants a row lock to its waiters in the order they queued.
      await withNamespaceLockHeld(fixture.pool, namespace.id, async (lock) => {
        stopping = fixture.request("POST", `${agentPath}/stop`);
        // Surface an early failure through the await below instead of an unhandled rejection.
        stopping.catch(() => {});
        await lock.waitForBlocked("Stop to wait on the Namespace lock");
        releaseHandoff();
        await waitFor("the handoff to queue behind Stop for the Namespace lock", async () => {
          const backend = await fixture.pool.query(
            "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
            [handoffPid],
          );
          return backend.rows[0]?.wait_event_type === "Lock" ? true : undefined;
        });
      });
      const stopped = await stopping;
      assert.equal(stopped.status, 202, JSON.stringify(stopped.body));
      assert.equal(stopped.data.desiredRuntimeState, "stopped");
      // Stop cancelled the job before the handoff got the lock, so the handoff's checkpoint
      // refuses the cancelled job and its pass ends without a deployment.
      await waitFor("the handoff's pass to end cancelled", async () =>
        events.some(
          (event) =>
            event.event === "worker.completed" &&
            event.workId === workId &&
            event.code === "PROVISIONING_CANCELLED",
        )
          ? true
          : undefined,
      );
    } finally {
      releaseHandoff();
      await stopping?.catch(() => {});
      await fixture.stopWorker();
    }

    // The whole handoff rolled back: no revision, no handoff checkpoint, and the job stays
    // cancelled at the transport phase it had completed.
    const finished = await provisioningJob(fixture.pool, workId);
    assert.deepEqual(
      [
        finished.status,
        finished.completed_phase,
        finished.revision_id,
        finished.work_state,
        finished.reason_code,
      ],
      ["cancelled", "transport", null, "failed_permanent", "PROVISIONING_CANCELLED"],
    );
    assert.equal(await handoffCheckpoints(fixture.pool, workId), 0);
    const revisions = await fixture.state.read((view) =>
      view.revisions.listRevisions(namespace.id, finished.agent_id),
    );
    assert.deepEqual(revisions, []);
    const status = await fixture.request("GET", url);
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(status.data.status, "failed");
    assert.equal(status.data.error?.code, "PROVISIONING_CANCELLED");
    assert.equal(status.data.revisionId, undefined);
  },
);

test(
  "Delete before admission cancels provisioning while a worker holds its claim, and finishes without a deployment",
  { ...requiresPostgres, timeout: 90_000 },
  async (context) => {
    let writing = false;
    let releaseWrite;
    const writeReleased = new Promise((resolve) => {
      releaseWrite = resolve;
    });
    const computeDriver = heldTransportDriver(async () => {
      writing = true;
      await writeReleased;
    });
    const fixture = await createFixture(context, { computeDriver });
    let target;
    let configurationId;
    try {
      target = await provisionUntilTransportWrite(fixture, () => writing);
      const { workId, url } = target.admitted.data.provisioning;
      configurationId = await provisioningConfigurationId(fixture.pool, workId);
      const agentPath = `/namespaces/${target.namespace.id}/agents/${target.agentId}`;
      const deleting = await fixture.request("DELETE", agentPath);
      assert.equal(deleting.status, 202, JSON.stringify(deleting.body));
      assert.equal(deleting.data.status, "deleting");
      // Delete cancels the job at once, though the worker is still inside its attempt.
      const cancelled = await fixture.request("GET", url);
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
      assert.equal(cancelled.data.status, "failed");
      assert.deepEqual(cancelled.data.error, {
        code: "PROVISIONING_CANCELLED",
        message: "Provisioning was cancelled because the Agent was deleted.",
      });
      assert.equal(cancelled.data.revisionId, undefined);

      // The write completes and records its receipt without the claim. The worker's next fence
      // finds the Agent deleting, so its pass ends before handoff; deletion then finishes.
      releaseWrite();
      await waitFor(
        "the Agent deletion to finish",
        async () => {
          const observed = await fixture.request("GET", agentPath);
          if (observed.status === 404) {
            return true;
          }
          assert.equal(observed.status, 200, JSON.stringify(observed.body));
          assert.equal(observed.data.status, "deleting");
          return undefined;
        },
        45_000,
      );
    } finally {
      releaseWrite();
      await fixture.stopWorker();
    }

    // No deployment was ever admitted for the deleting Agent: the job never checkpointed a
    // handoff, and Compute never prepared a revision for it.
    const { workId } = target.admitted.data.provisioning;
    assert.equal(await handoffCheckpoints(fixture.pool, workId), 0);
    assert.equal(
      computeDriver.calls.some(
        ({ operation, agentId }) => operation === "prepareRevision" && agentId === target.agentId,
      ),
      false,
    );
    // Deletion removed the job, its work and the runtime credentials the write stored.
    const remaining = await fixture.pool.query(
      `SELECT
         (SELECT count(*) FROM occ.agent_provisioning_work WHERE work_id = $1)::int AS jobs,
         (SELECT count(*) FROM occ.controller_work WHERE idempotency_key = $1)::int AS work,
         (SELECT count(*) FROM occ.agent_revisions
           WHERE namespace_id = $2 AND agent_id = $3)::int AS revisions`,
      [workId, target.namespace.id, target.agentId],
    );
    assert.deepEqual(remaining.rows, [{ jobs: 0, work: 0, revisions: 0 }]);
    assert.equal(
      computeDriver.calls.filter(
        ({ operation, agentId }) =>
          operation === "deleteAgentRuntimeCredentials" && agentId === target.agentId,
      ).length,
      1,
    );
    // The job's Configuration is no longer reserved, so it deletes like any other.
    const configurationPath = `/namespaces/${target.namespace.id}/configurations/${configurationId}`;
    const removed = await fixture.request("DELETE", configurationPath);
    assert.equal(removed.status, 204, JSON.stringify(removed.body));
    const gone = await fixture.request("GET", configurationPath);
    assert.equal(gone.status, 404, JSON.stringify(gone.body));
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
            expectedGeneration: configuration.data.generation,
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
    // Without the stale-generation detail, the console shows this refusal instead of offering a
    // Reload draft that would meet it again (finding 1511).
    assert.equal(reserved[3].body.error.details, undefined);
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
