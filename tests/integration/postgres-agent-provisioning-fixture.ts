import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import pg from "pg";

import type { PostgresDevelopmentConfig } from "../../apps/controller/src/composition/development-postgres.ts";
import type { InstallationRuntimeDrivers } from "../../apps/controller/src/composition/installation-config.ts";
import {
  createControllerWorker,
  type ControllerWorkerOptions,
} from "../../apps/controller/src/worker.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { composePostgresDevelopment } from "../helpers/password-hasher.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { waitFor } from "../helpers/wait-for.mjs";

interface FixtureDrivers {
  computeDriver: InstallationRuntimeDrivers["computeDriver"];
  configurationDriver: InstallationRuntimeDrivers["configurationDriver"];
  secretDriver: InstallationRuntimeDrivers["secretDriver"];
  repoDriver?: InstallationRuntimeDrivers["repositoryPolicy"];
  pluginDriver?: NonNullable<InstallationRuntimeDrivers["pluginDrivers"]>[number] | undefined;
  sandboxDriver?: InstallationRuntimeDrivers["sandboxDriver"];
  credentialGatewayDriver?: InstallationRuntimeDrivers["credentialGatewayDriver"];
}

type WorkerEventListener = NonNullable<ControllerWorkerOptions["emit"]>;
type WorkerEvent = Parameters<WorkerEventListener>[0];
type WorkerStatementHook = (
  statement: string,
  values: unknown[] | undefined,
  processId: number,
) => void | Promise<void>;

interface FixtureOptions extends Partial<FixtureDrivers> {
  slackFetch?: typeof fetch;
  nativeAdmin?: boolean;
  nativeAdminDomain?: string;
  beforeWorkerStatement?: WorkerStatementHook;
  leaseDurationMs?: number;
  onWorkerEvent?: WorkerEventListener;
  stopAfterProvisioning?: boolean;
  stopWorkerAfter?: (event: WorkerEvent) => boolean | undefined;
}

type FixtureApp = Awaited<ReturnType<typeof composePostgresDevelopment>>;

interface FixtureSession {
  cookie: string;
  origin?: string;
}

interface ProvisioningClaim {
  idempotencyKey: string;
  claimToken: string;
}

interface FixtureDependencies {
  databaseUrl: string;
  adminEmail: string;
  adminPassword: string;
  authBaseURL: string;
  authSecret: string;
  ensureProvisioningBootstrap: (
    context: TestContext,
    state: PostgresPlatformState,
  ) => Promise<void>;
  signInToControllerApp: (
    app: FixtureApp,
    credentials: { email: string; password: string },
    options: { origin: string },
  ) => Promise<FixtureSession>;
  createRuntimeComputeDriver: () => FixtureDrivers["computeDriver"];
  createProvisioningConfigurationDriver: (options: {
    id: string;
  }) => FixtureDrivers["configurationDriver"];
  createTestSecretDriver: (options: { id: string }) => FixtureDrivers["secretDriver"];
  identifier: (prefix: string) => RegExp;
  claimProvisioningWork: (
    pool: pg.Pool,
    workId: string,
    options: { ifQueued: boolean },
  ) => Promise<ProvisioningClaim | undefined>;
}

interface RevokedBindingRow {
  id: string;
  namespace_id: string | null;
  identity_subject_id: string | null;
  group_subject_id: string | null;
  role_id: string;
  resource_kind: string | null;
  resource_id: string | null;
}

type RequestMethod = "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";

interface RequestOptions {
  body?: unknown;
  session?: FixtureSession | string | null;
}

interface ResponseEnvelope<Data> {
  meta?: { requestId?: string } | null;
  data?: Data;
  error?: unknown;
}

interface FixtureNamespace {
  id: string;
  status: string;
}

interface SessionData {
  user: { id: string };
}

function installationDrivers({
  computeDriver,
  configurationDriver,
  secretDriver,
  repoDriver,
  pluginDriver,
  sandboxDriver,
  credentialGatewayDriver,
}: FixtureDrivers): InstallationRuntimeDrivers {
  return {
    // The fixture injects Drivers directly and omits loader-only definitions and a logging level.
    installation: {
      occ: { cluster: "postgres-agent-provisioning" },
      logging: {},
      backend: [
        ...(repoDriver === undefined
          ? []
          : [
              {
                id: "provisioning-repositories",
                type: "github" as const,
                configuration: { registryPath: "/unused/provisioning/registry.json" },
                drivers: { repo: repoDriver.id },
              },
            ]),
        ...(credentialGatewayDriver === undefined
          ? []
          : [
              {
                id: "provisioning-credential-gateway",
                type: "openshell" as const,
                configuration: {
                  endpoint: "http://127.0.0.1:8080",
                  insecureTransport: "network-policy" as const,
                },
                drivers: {
                  sandbox: sandboxDriver!.id,
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
    } as unknown as InstallationRuntimeDrivers["installation"],
    computeDriver,
    configurationDriver,
    secretDriver,
    ...(sandboxDriver === undefined ? {} : { sandboxDriver }),
    ...(credentialGatewayDriver === undefined ? {} : { credentialGatewayDriver }),
    ...(repoDriver === undefined
      ? {}
      : {
          repositoryPolicy: repoDriver,
          repositoryAdmission: {
            // Use the same fixture policy for both admission and Worker resolution.
            policy: repoDriver as NonNullable<
              InstallationRuntimeDrivers["repositoryAdmission"]
            >["policy"],
            backendId: "provisioning-repositories",
          },
        }),
    pluginDrivers: pluginDriver === undefined ? [] : [pluginDriver],
    createIAMDriver: (state) =>
      new NativeIAMDriver(state, { id: "native-iam", implementation: "native" }),
  };
}

// The pg overloads share a runtime implementation. Keep the original arguments on passthrough.
type ClientQuery = (config: unknown, values?: unknown, callback?: unknown) => unknown;

// Runs `before(statement, values, backendPid)` ahead of each statement a worker transaction sends,
// and sends the statement once it settles. Lock-order tests use it to pause the worker at one
// exact statement; the paused transaction then runs unchanged against the real database.
// Callback-style calls, such as `pool.query` for the work queue's claim and heartbeat, skip the
// hook.
function holdWorkerStatements(pool: pg.Pool, before: WorkerStatementHook) {
  pool.on("connect", (client) => {
    const query = client.query.bind(client) as unknown as ClientQuery;
    const intercepted: ClientQuery = (config, values, callback) =>
      typeof config === "string" && typeof values !== "function" && callback === undefined
        ? Promise.resolve(
            before(
              config,
              values as unknown[] | undefined,
              (client as pg.PoolClient & { processID: number }).processID,
            ),
          ).then(() => query(config, values))
        : query(config, values, callback);
    client.query = intercepted as unknown as typeof client.query;
  });
}

export async function createProvisioningFixture(
  context: TestContext,
  options: FixtureOptions,
  {
    databaseUrl,
    adminEmail,
    adminPassword,
    authBaseURL,
    authSecret,
    ensureProvisioningBootstrap,
    signInToControllerApp,
    createRuntimeComputeDriver,
    createProvisioningConfigurationDriver,
    createTestSecretDriver,
    identifier,
    claimProvisioningWork,
  }: FixtureDependencies,
) {
  // Keep real admission and Secret access; only Slack's external response is a fixture.
  const originalFetch = globalThis.fetch;
  context.mock.method(globalThis, "fetch", (async (url, init) => {
    if (String(url) === "https://slack.com/api/auth.test") {
      assert.match(
        (init as { headers: { authorization: string } }).headers.authorization,
        /^Bearer xoxb-/,
      );
      return options.slackFetch === undefined
        ? Response.json({ ok: true, bot_id: "B0123456789", team_id: "T0123456789" })
        : options.slackFetch(url, init);
    }
    return originalFetch(url, init);
  }) satisfies typeof originalFetch);
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
  let worker: ReturnType<typeof createControllerWorker> | undefined;
  let workerPool: pg.Pool | undefined;
  let workerCompletion: Promise<void> | undefined;
  const revokedBindings: RevokedBindingRow[] = [];
  const teardownCancellations: { namespaceId: string; agentId: string }[] = [];
  const teardownWorkCancellations: { workId: string; message: string }[] = [];
  const drivers = installationDrivers({
    computeDriver,
    configurationDriver,
    secretDriver,
    repoDriver: options.repoDriver,
    pluginDriver: options.pluginDriver,
    sandboxDriver: options.sandboxDriver,
    credentialGatewayDriver: options.credentialGatewayDriver,
  });
  const origin = options.nativeAdmin ? "https://console.oce.localhost:9443" : authBaseURL;
  let nativeAdminSettings: Pick<PostgresDevelopmentConfig, "nativeAdmin" | "gatewayApiKeyPath"> = {
    nativeAdmin: { enabled: false, domain: "agents.oce.localhost" },
  };
  if (options.nativeAdmin) {
    const directory = await temporaryDirectory(context, "native-admin-provisioning-");
    const gatewayApiKeyPath = join(directory, "gateway-key");
    await writeFile(gatewayApiKeyPath, `test-gateway-${randomUUID()}`, { mode: 0o600 });
    nativeAdminSettings = {
      nativeAdmin: {
        enabled: true,
        domain: options.nativeAdminDomain ?? "agents.oce.localhost",
      },
      gatewayApiKeyPath,
    };
  }
  const settings: PostgresDevelopmentConfig = {
    mode: "development",
    host: "127.0.0.1",
    databaseUrl,
    authSecret,
    authBaseURL: origin,
    ...nativeAdminSettings,
  };
  let app = await composePostgresDevelopment(settings, drivers);
  const session = await signInToControllerApp(app, credentials, { origin });

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

  async function request<Data = unknown>(
    method: RequestMethod,
    path: string,
    { body, session: selectedSession = session }: RequestOptions = {},
  ) {
    const headers = {
      ...(selectedSession === null ? {} : authenticatedHeaders(selectedSession)),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(method === "GET" ? {} : { origin }),
      host: new URL(origin).host,
    };
    const response = await app.inject({
      method,
      url: path,
      headers,
      remoteAddress: "127.0.0.1",
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    const text = response.body;
    const payload = text.length === 0 ? undefined : (JSON.parse(text) as ResponseEnvelope<Data>);
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

  async function bootstrapNamespace(): Promise<FixtureNamespace> {
    const namespace = await request<FixtureNamespace>("POST", "/namespaces", {
      body: { name: `agent-provisioning-${randomUUID().slice(0, 8)}` },
    });
    assert.equal(namespace.status, 201, JSON.stringify(namespace.body));
    await startWorker();
    try {
      return await waitFor(`Namespace ${namespace.data!.id} to become ready`, async () => {
        const observed = await request<FixtureNamespace>(
          "GET",
          `/namespaces/${namespace.data!.id}`,
        );
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        return observed.data!.status === "ready" ? observed.data : undefined;
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

  async function restartApi() {
    await app.close();
    app = await composePostgresDevelopment(settings, drivers);
  }

  // The signed-in administrator's Principal, whose subject is its account: a test may add
  // other administrators, so the first better-auth Principal is not necessarily this one.
  async function administratorPrincipalId() {
    const current = await request<SessionData>("GET", "/api/auth/session");
    assert.equal(current.status, 200, JSON.stringify(current.body));
    const iam = await state.loadNativeIAMState();
    const principals = iam.identities.filter(
      (identity) =>
        identity.kind === "principal" &&
        identity.issuer.endsWith(":better-auth") &&
        identity.subject === current.data!.user.id,
    );
    assert.equal(principals.length, 1, "exactly one Principal must match the signed-in account");
    return principals[0]!.id;
  }

  async function revokeCurrentPrincipal() {
    const principalId = await administratorPrincipalId();
    const result = await pool.query<RevokedBindingRow>(
      `DELETE FROM occ.iam_access_bindings
       WHERE identity_subject_id = $1
         AND namespace_id IS NULL
       RETURNING id, namespace_id, identity_subject_id, group_subject_id, role_id,
                 resource_kind, resource_id`,
      [principalId],
    );
    assert.ok(
      (result.rowCount as number) > 0,
      "revocation must remove the exact administrator binding",
    );
    revokedBindings.push(...result.rows);
    return principalId;
  }

  function cancelProvisioningAtTeardown(namespaceId: string, agentId: string) {
    teardownCancellations.push({ namespaceId, agentId });
  }

  // Cancel this provisioning work at teardown if it is still queued then.
  function cancelQueuedWorkAtTeardown(workId: string, message: string) {
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
    restartApi,
    request,
    secretDriver,
    session,
    startWorker,
    state,
    stopWorker,
  };
}
