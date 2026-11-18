import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import pg from "pg";
import type { Static, TSchema } from "typebox";
import { Check } from "typebox/value";
import { defaultAgentModel } from "../../apps/controller/src/console/agents/starter-model.mts";
import { composePostgresDevelopment } from "../../apps/controller/src/composition/development-postgres.ts";
import type { InstallationRuntimeDrivers } from "../../apps/controller/src/composition/installation-config.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { KubernetesConfigurationDriver } from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import type { KubernetesAuthentication } from "../../apps/controller/src/drivers/kubernetes/authentication.ts";
import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { KubernetesSecretDriver } from "../../apps/controller/src/drivers/secret/kubernetes/index.ts";
import {
  createControllerWorker,
  type ControllerWorkerOptions,
} from "../../apps/controller/src/worker.ts";
import { JsonValue, PluginApproversSchema } from "../../packages/contracts/src/api/common.ts";
import {
  PluginDesiredSelectionSchema,
  PluginDesiredStateSchema,
  PluginDriverIdentitySchema,
  PluginToolDefaultsSchema,
  PluginToolPolicySchema,
} from "../../packages/contracts/src/api/resources.ts";
import type { SecretReference } from "../../packages/contracts/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { PostgresPlatformState, type ControllerWorkState } from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, signInToControllerApp } from "./auth-session.mjs";
import {
  ensureDevelopmentBootstrap,
  privateBootstrapDirectory,
} from "./bootstrap-installation.mjs";
import { databaseUrl } from "./kubernetes-compute-real.mjs";
import {
  ConnectionTemplateSchema,
  OAuthConnectionTemplateVersionSchema,
  StaticKeyConnectionTemplateVersionSchema,
} from "../../packages/contracts/src/api/connection-templates.ts";

const responseSchemas = {
  ConnectionTemplate: ConnectionTemplateSchema,
  OAuthConnectionTemplateVersion: OAuthConnectionTemplateVersionSchema,
  StaticKeyConnectionTemplateVersion: StaticKeyConnectionTemplateVersionSchema,
  PluginApprovers: PluginApproversSchema,
  PluginDesiredSelection: PluginDesiredSelectionSchema,
  PluginDesiredState: PluginDesiredStateSchema,
  PluginDriverIdentity: PluginDriverIdentitySchema,
  PluginToolDefaults: PluginToolDefaultsSchema,
  PluginToolPolicy: PluginToolPolicySchema,
  SafeJsonValue: JsonValue,
};

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

interface HttpResponse {
  status: number;
  body: unknown;
}

export function readProvisioningResponse<Schema extends TSchema>(
  schema: Schema,
  response: HttpResponse,
): Static<Schema, typeof responseSchemas> {
  assert.ok(
    Check(responseSchemas, schema, response.body),
    `HTTP ${response.status}: ${JSON.stringify(response.body)}`,
  );
  return response.body;
}

export function provisioningRequestBody({
  modelSecretRef,
  slackBotSecretRef,
  authMethod = "api_key",
  gatewayAuth,
}: {
  modelSecretRef: SecretReference;
  slackBotSecretRef: SecretReference;
  authMethod?: "api_key" | "codex_pat";
  gatewayAuth: Readonly<Record<string, unknown>>;
}) {
  const model = `codex/${defaultAgentModel}`;
  return {
    requestId: `req_${randomUUID()}`,
    name: `Kubernetes provisioned ${randomUUID().slice(0, 8)}`,
    executionMode: "dedicated",
    configuration: {
      kind: "agent",
      values: {
        gateway: { controlUi: { enabled: false }, auth: gatewayAuth },
        agents: {
          defaults: {
            model,
            models: { [model]: { agentRuntime: { id: "codex" } } },
          },
        },
        channels: {
          slack: {
            enabled: true,
            mode: "http",
            botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
          },
        },
      },
      secretBindings: {
        SLACK_BOT_TOKEN: {
          source: slackBotSecretRef,
          delivery: { type: "env" },
        },
      },
    },
    harnessAuth: {
      method: authMethod,
      source: modelSecretRef,
    },
  } as const;
}

function runtimeDrivers(
  computeDriver: KubernetesComputeDriver,
  configurationDriver: KubernetesConfigurationDriver,
  secretDriver: KubernetesSecretDriver,
): InstallationRuntimeDrivers {
  return {
    installation: {
      occ: { cluster: "kubernetes-agent-provisioning" },
      logging: { level: "info" },
      backend: [],
      drivers: {
        iam: {
          id: "native-iam",
          implementation: "native",
          configuration: {},
          definition: NativeIAMDriver,
        },
        compute: {
          id: computeDriver.id,
          implementation: computeDriver.implementation,
          definition: KubernetesComputeDriver,
          configuration: {},
        },
        configuration: {
          id: configurationDriver.id,
          implementation: configurationDriver.implementation,
          definition: KubernetesConfigurationDriver,
          configuration: {},
        },
        secret: {
          id: secretDriver.id,
          implementation: secretDriver.implementation,
          definition: KubernetesSecretDriver,
          configuration: {},
        },
      },
    },
    computeDriver,
    configurationDriver,
    secretDriver,
    pluginDrivers: [new CodexPluginDriver()],
    createIAMDriver: (state) =>
      new NativeIAMDriver(state, { id: "native-iam", implementation: "native" }),
  };
}

export function createProvisioningContext(test: TestContext) {
  const services = new AsyncDisposableStack();
  const releases: (() => void | Promise<unknown>)[] = [() => services.disposeAsync()];
  test.after(async () => {
    // Keep Kubernetes access until the worker and API close. A timeout can finish
    // another acquisition during teardown, so visit new registrations in order.
    const errors: unknown[] = [];
    for (const release of releases) {
      try {
        await release();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Kubernetes provisioning fixture cleanup failed");
    }
  });
  return {
    mock: test.mock,
    signal: test.signal,
    services,
    after(release: () => void | Promise<unknown>) {
      releases.push(release);
    },
  };
}

export type ProvisioningContext = ReturnType<typeof createProvisioningContext>;

export async function createProvisioningApiFixture(
  context: ProvisioningContext,
  computeDriver: KubernetesComputeDriver,
  authentication: KubernetesAuthentication,
  emit: NonNullable<ControllerWorkerOptions["emit"]>,
) {
  assert.ok(databaseUrl, "OCC_TEST_DATABASE_URL is required");
  const connectionString = databaseUrl;
  // The real Slack admission path reads a stored Secret. Keep the network call local
  // and save only a boolean for assertion after the request has completed.
  const originalFetch = globalThis.fetch;
  const slackValidations: boolean[] = [];
  context.mock.method(globalThis, "fetch", async (...[url, init]: Parameters<typeof fetch>) => {
    if (String(url) === "https://slack.com/api/auth.test") {
      slackValidations.push(
        /^Bearer xoxb-/.test(new Headers(init?.headers).get("authorization") ?? ""),
      );
      return Response.json({ ok: true, bot_id: "B0123456789", team_id: "T0123456789" });
    }
    return originalFetch(url, init);
  });
  let worker: ReturnType<typeof createControllerWorker> | undefined;
  let startup: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  context.signal.throwIfAborted();
  const pool = new pg.Pool({ connectionString, max: 6 });
  context.services.defer(() => pool.end());
  const state = new PostgresPlatformState(pool);
  const existingInstallation = await state.loadInstallation();
  const authSecret = "kubernetes-integration-auth-secret-32-bytes";
  const authBaseURL = "https://console.oce.localhost";
  const credentials = {
    email: "admin-kubernetes-integration@example.test",
    password: "kubernetes-integration-admin-password",
  };
  if (existingInstallation === undefined) {
    await ensureDevelopmentBootstrap(context, {
      databaseUrl,
      directory: await privateBootstrapDirectory(
        context,
        "openclaw-kubernetes-provisioning-bootstrap-",
      ),
      email: credentials.email,
      password: credentials.password,
      authSecret,
      authBaseURL,
      agentDomain: "agents.oce.localhost",
      installationName: "OpenClaw Kubernetes integration",
      environment: { PATH: process.env.PATH },
    });
  }
  const bootstrapNamespaceIds = (await state.read((view) => view.namespaces.listNamespaces())).map(
    ({ id }) => id,
  );
  const configurationDriver = new KubernetesConfigurationDriver(
    { authentication },
    { id: "configuration-kubernetes-provisioning" },
  );
  const secretDriver = new KubernetesSecretDriver(
    { authentication },
    { id: "secret-kubernetes-provisioning" },
  );
  const drivers = runtimeDrivers(computeDriver, configurationDriver, secretDriver);
  context.signal.throwIfAborted();
  const startingApp = composePostgresDevelopment(
    {
      mode: "development",
      host: "127.0.0.1",
      databaseUrl,
      authSecret,
      authBaseURL,
      nativeAdmin: { enabled: false, domain: "agents.oce.localhost" },
    },
    drivers,
  );
  context.services.defer(async () => {
    const app = await startingApp;
    await app.close();
  });
  context.services.defer(stopWorker);
  const startedApp = await startingApp;
  const session: { cookie: string; origin: string } = await signInToControllerApp(
    startedApp,
    credentials,
  );

  async function request(method: HttpMethod, path: string, body?: unknown): Promise<HttpResponse> {
    const response = await startedApp.inject({
      method,
      url: path,
      headers: {
        ...authenticatedHeaders(session),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(method === "GET" ? {} : { origin: authBaseURL }),
        host: new URL(authBaseURL).host,
      },
      remoteAddress: "127.0.0.1",
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    const payload: unknown = response.body.length === 0 ? undefined : JSON.parse(response.body);
    return { status: response.statusCode, body: payload };
  }

  async function requestChecked<Schema extends TSchema>(
    schema: Schema,
    expectedStatus: number,
    method: HttpMethod,
    path: string,
    body?: unknown,
  ): Promise<Static<Schema, typeof responseSchemas>> {
    const response = await request(method, path, body);
    assert.equal(response.status, expectedStatus, JSON.stringify(response.body));
    return readProvisioningResponse(schema, response);
  }

  async function startWorker() {
    await stopping;
    context.signal.throwIfAborted();
    assert.equal(worker, undefined, "the fixture worker is already running");
    const workerPool = new pg.Pool({ connectionString, max: 6 });
    try {
      worker = createControllerWorker({
        pool: workerPool,
        drivers,
        pollIntervalMs: 25,
        leaseDurationMs: 30_000,
        maxAttempts: 3,
        emit,
      });
    } catch (error) {
      await workerPool.end();
      throw error;
    }
    startup = worker.start();
    try {
      await startup;
    } finally {
      startup = undefined;
    }
  }

  function stopWorker(): Promise<void> | undefined {
    if (worker !== undefined) {
      const current = worker;
      worker = undefined;
      // The pending event can call stop from inside the worker loop. Every other
      // caller must join that same shutdown before starting a new worker.
      stopping = startup === undefined ? current.stop() : startup.finally(() => current.stop());
    }
    return stopping;
  }

  return {
    bootstrapNamespaceIds,
    async readWork(idempotencyKey: string) {
      const result = await pool.query<{ state: ControllerWorkState; reason_code: string | null }>(
        "SELECT state, reason_code FROM occ.controller_work WHERE idempotency_key = $1",
        [idempotencyKey],
      );
      return result.rows[0];
    },
    request,
    requestChecked,
    slackValidations,
    startWorker,
    stopWorker,
  };
}
