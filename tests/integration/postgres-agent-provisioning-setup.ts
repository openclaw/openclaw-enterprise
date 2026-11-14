import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type TestContext } from "node:test";
import pg from "pg";
import Type from "typebox";
import { Check } from "typebox/value";
import { ErrorResponse, Meta } from "../../packages/contracts/src/api/common.ts";
import {
  AgentProvisioningResponse,
  SecretResponse,
} from "../../packages/contracts/src/api/resources.ts";
import type {
  AgentProvisioningStatusWire,
  ComputeDriver,
  ProvisionAgentBody,
  SecretWire,
} from "../../packages/contracts/src/index.ts";
import type {
  AgentProvisioningRecord,
  PostgresPlatformState,
  WorkClaim,
} from "../../packages/occ/src/index.ts";

import { signInToControllerApp as signInAccount } from "../helpers/auth-session.mjs";
import {
  ensureDevelopmentBootstrap,
  privateBootstrapDirectory,
} from "../helpers/bootstrap-installation.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { databaseUrl } from "../helpers/postgres-database.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";
import { createProvisioningFixture } from "./postgres-agent-provisioning-fixture.ts";
import { createRuntimeComputeDriver } from "./postgres-agent-provisioning-transport-fixture.ts";

export type Fixture = Awaited<ReturnType<typeof createProvisioningFixture>>;
type BootstrapOptions = {
  databaseUrl: string;
  directory: string;
  email: string;
  password: string;
  authSecret: string;
  authBaseURL: string;
  agentDomain: string;
  installationName: string;
  environment: NodeJS.ProcessEnv;
};
const bootstrapDirectory: (context: TestContext, prefix: string) => Promise<string> =
  privateBootstrapDirectory;
const bootstrap: (context: TestContext, options: BootstrapOptions) => Promise<unknown> =
  ensureDevelopmentBootstrap;
export function handedOff(status: AgentProvisioningStatusWire) {
  const { agentId, configurationId, revisionId } = status;
  assert.ok(agentId, "Provisioning must identify its Agent after handoff");
  assert.ok(configurationId, "Provisioning must identify its Configuration after handoff");
  assert.ok(revisionId, "Provisioning must identify its revision after handoff");
  return { ...status, agentId, configurationId, revisionId };
}

export type FixtureOptions = Parameters<typeof createProvisioningFixture>[1];
export type ProvisioningSecrets = Record<
  "modelKey" | "slackBotToken" | "slackSigningSecret" | "externalServiceToken",
  SecretWire
>;
export type WorkerEvent = Parameters<NonNullable<FixtureOptions["onWorkerEvent"]>>[0];
export type ProvisioningPhase = AgentProvisioningRecord["completedPhase"];

interface ProvisioningRow {
  work_id: string;
  agent_id: string | null;
  configuration_id: string | null;
  revision_id: string | null;
  status: AgentProvisioningRecord["status"];
  completed_phase: ProvisioningPhase;
  plan: Record<string, unknown>;
  progress: unknown;
}

const effectOwner = Type.Optional(Type.String());
const effectTarget = {
  kind: Type.Union([Type.Literal("configuration"), Type.Literal("transport")]),
  targetId: Type.String(),
};
const pendingEffectSchema = Type.Object({ ...effectTarget, owner: effectOwner });
const provisioningProgressRow = Type.Object({
  error: Type.Optional(Type.Object({ code: Type.String(), message: Type.String() })),
  pendingEffect: Type.Optional(pendingEffectSchema),
  effectReceipt: Type.Optional(Type.Object({ ...effectTarget, owner: Type.String() })),
  unrecordedConfigurationId: Type.Optional(Type.String()),
});

export function required<T>(value: T, message = "Expected a value"): NonNullable<T> {
  assert.ok(value !== undefined && value !== null, message);
  return value;
}

export function readPendingEffect(value: unknown) {
  assert.ok(Check(pendingEffectSchema, value));
  return value;
}

export const authAccountResponse = Type.Object({
  data: Type.Object({ principalId: Type.String() }),
  meta: Meta,
});

export function provisioningError(response: { body: unknown }) {
  assert.ok(Check(ErrorResponse, response.body), JSON.stringify(response.body));
  return response.body.error;
}

function requireDatabaseUrl() {
  assert.ok(databaseUrl);
  return databaseUrl;
}

export const adminEmail = "postgres-agent-provisioning-v2@example.test";
export const adminPassword = "postgres-agent-provisioning-password";
const authBaseURL = "https://console.oce.localhost";
const authSecret = "postgres-agent-provisioning-auth-secret-32-bytes";
let bootstrapPromise: Promise<void> | undefined;
type SignIn = typeof signInAccount;
const administratorSessions = new Map<string, ReturnType<SignIn>>();
const uuidV4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
export const identifier = (prefix: string) => new RegExp(`^${prefix}_${uuidV4}$`);
const defaultModel = "codex/gpt-6-astra";

// The bootstrap administrator signs in once per file (and per set of sign-in options): every
// fixture's app reads the same stored session (same database and auth secret). No test ends it,
// and a revoked administrator binding is restored at teardown. Any other account or password
// signs in on every call.
export const signInToControllerApp: SignIn = (app, credentials, ...options) => {
  if (credentials.email !== adminEmail || credentials.password !== adminPassword) {
    return signInAccount(app, credentials, ...options);
  }
  const key = JSON.stringify(options);
  const cached = administratorSessions.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const pending = signInAccount(app, credentials, ...options).catch((error: unknown) => {
    administratorSessions.delete(key);
    throw error;
  });
  administratorSessions.set(key, pending);
  return pending;
};

export function agentDefaults() {
  return {
    model: defaultModel,
    models: { [defaultModel]: { agentRuntime: { id: "codex" } } },
  };
}

export function requestId() {
  return `req_${randomUUID()}`;
}

export function secretRef(namespaceId: string, id: string) {
  return { kind: "secret" as const, namespaceId, id };
}

export async function createNamespaceSecret(
  fixture: Pick<Fixture, "requestChecked">,
  namespaceId: string,
  name: string,
  value = `${name}-${randomUUID()}`,
) {
  const created = await fixture.requestChecked(
    SecretResponse,
    "POST",
    `/namespaces/${namespaceId}/secrets`,
    {
      body: { name, value },
    },
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.data;
}

export async function createProvisioningSecrets(
  fixture: Pick<Fixture, "requestChecked">,
  namespaceId: string,
) {
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

export function provisioningBody(
  namespaceId: string,
  secrets: ProvisioningSecrets,
  { name, requestId: id }: Pick<Partial<ProvisionAgentBody>, "name" | "requestId"> = {},
) {
  return {
    requestId: id ?? requestId(),
    name: name ?? `Provisioned ${randomUUID().slice(0, 8)}`,
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
  } satisfies ProvisionAgentBody;
}

export async function requestAcceptedProvisioning(
  fixture: Pick<Fixture, "requestChecked">,
  namespaceId: string,
  secrets: ProvisioningSecrets,
  overrides: Partial<ProvisionAgentBody> = {},
) {
  const body = { ...provisioningBody(namespaceId, secrets, overrides), ...overrides };
  const admitted = await fixture.requestChecked(
    AgentProvisioningResponse,
    "POST",
    `/namespaces/${namespaceId}/agents/provision`,
    {
      body,
    },
  );
  assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
  assert.ok(admitted.data.provisioning, JSON.stringify(admitted.body));
  assert.equal(
    admitted.data.provisioning.requestId,
    body.requestId,
    "provisioning must echo the submitted request ID",
  );
  return admitted;
}

export function createProvisioningConfigurationDriver(
  options: Parameters<typeof createTestConfigurationDriver>[0],
) {
  const driver = createTestConfigurationDriver(options);
  const createExact: NonNullable<typeof driver.createExact> = (configuration) =>
    driver.create(configuration);
  const inspectExact: NonNullable<typeof driver.inspectExact> = async (configuration) => {
    try {
      const stored = await driver.read(configuration);
      assert.deepEqual(stored, configuration);
      return stored;
    } catch {
      return undefined;
    }
  };
  return Object.assign(driver, { createExact, inspectExact });
}

export function refuseProvisioningWithoutGatewayRouting(computeDriver: ComputeDriver) {
  const unrouted = createTestKubernetesComputeDriver("compute-provisioning-unrouted", {
    repositoryCredentials: true,
    routed: false,
  });
  computeDriver.validateAgentProvisioning = (input) => unrouted.validateAgentProvisioning(input);
}

async function ensureProvisioningBootstrap(context: TestContext, state: PostgresPlatformState) {
  if ((await state.loadInstallation()) !== undefined) {
    return;
  }
  bootstrapPromise ??= (async () => {
    await bootstrap(context, {
      databaseUrl: requireDatabaseUrl(),
      directory: await bootstrapDirectory(context, "openclaw-agent-provisioning-bootstrap-"),
      email: adminEmail,
      password: adminPassword,
      authSecret,
      authBaseURL,
      agentDomain: "agents.oce.localhost",
      installationName: "Agent provisioning integration",
      environment: { PATH: process.env.PATH },
    });
  })();
  await bootstrapPromise;
}

/** The provisioning jobs and Agents a Namespace holds; a refused request stores neither. */
export async function storedProvisioningCounts(pool: pg.Pool, namespaceId: string) {
  const { rows } = await pool.query<{ jobs: number; agents: number }>(
    `SELECT
     (SELECT count(*)::integer FROM occ.agent_provisioning_work WHERE namespace_id = $1) AS jobs,
     (SELECT count(*)::integer FROM occ.agents WHERE namespace_id = $1) AS agents`,
    [namespaceId],
  );
  assert.ok(rows[0]);
  return rows[0];
}

// The statement every Namespace-first path (Stop, Delete, the provisioning fences and deploy
// admission) uses to take the Namespace lock.
export const namespaceLockStatement =
  /\bFROM occ\.namespaces\s+WHERE id = \$1\b[^;]*\bFOR UPDATE\s*$/;

export async function createFixture<
  Compute extends ComputeDriver = ReturnType<typeof createRuntimeComputeDriver>,
  Secret extends NonNullable<FixtureOptions["secretDriver"]> = ReturnType<
    typeof createTestSecretDriver
  >,
>(
  context: TestContext,
  options: Omit<FixtureOptions, "computeDriver" | "secretDriver"> & {
    computeDriver?: Compute;
    secretDriver?: Secret;
  } = {},
) {
  return createProvisioningFixture(context, options, {
    databaseUrl: requireDatabaseUrl(),
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
  });
}

export async function assertProvisionedSecretAccess(
  fixture: Pick<Fixture, "pool"> & { secretDriver: ReturnType<typeof createTestSecretDriver> },
  namespace: { id: string },
  status: AgentProvisioningStatusWire,
  secretCreateCallCount: number,
) {
  assert.equal(
    fixture.secretDriver.calls.filter(({ operation }) => operation === "create").length,
    secretCreateCallCount,
    "provisioning must reuse Console-created Secrets instead of creating new Secret values",
  );

  const persistedSecrets = await fixture.pool.query<{ id: string; name: string }>(
    "SELECT id, name FROM occ.secrets WHERE namespace_id = $1 ORDER BY name",
    [namespace.id],
  );
  assert.deepEqual(
    persistedSecrets.rows.map(({ name }) => name),
    ["external-service-token", "model-api-key", "slack-bot-token", "slack-signing-secret"],
  );
  const grantRoleId = `role_${namespace.id}_agent_secret_operate`;
  const grantRole = await fixture.pool.query<{ permissions: unknown }>(
    "SELECT permissions FROM occ.iam_roles WHERE namespace_id = $1 AND id = $2",
    [namespace.id, grantRoleId],
  );
  assert.equal(grantRole.rowCount, 1);
  assert.deepEqual(required(grantRole.rows[0]).permissions, [
    { action: "operate", resourceKind: "secret" },
  ]);
  const grants = await fixture.pool.query<{ resource_id: string | null }>(
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
  const configuration = await fixture.pool.query<{
    generation: number | string;
    secret_bindings: unknown;
  }>(
    "SELECT generation, secret_bindings FROM occ.configurations WHERE namespace_id = $1 AND id = $2",
    [namespace.id, status.configurationId],
  );
  assert.equal(configuration.rowCount, 1);
  assert.equal(Number(required(configuration.rows[0]).generation), 1);
  const bindings = required(configuration.rows[0]).secret_bindings;
  assert.ok(typeof bindings === "object" && bindings !== null);
  assert.deepEqual(Object.keys(bindings).sort(), [
    "EXTERNAL_SERVICE_TOKEN",
    "SLACK_BOT_TOKEN",
    "SLACK_SIGNING_SECRET",
  ]);
}

export async function provisioningRow(pool: pg.Pool, namespaceId: string, requestId: string) {
  const result = await pool.query<ProvisioningRow>(
    "SELECT * FROM occ.agent_provisioning_work WHERE namespace_id = $1 AND request_id = $2",
    [namespaceId, requestId],
  );
  assert.equal(result.rowCount, 1, "provisioning admission must persist one request record");
  const row = result.rows[0];
  assert.ok(row);
  assert.ok(typeof row.plan === "object" && row.plan !== null && !Array.isArray(row.plan));
  assert.ok(Check(provisioningProgressRow, row.progress));
  return { ...row, progress: row.progress };
}

// With ifQueued, work that is no longer queued is left alone and returns undefined.
export function claimProvisioningWork(pool: pg.Pool, workId: string): Promise<WorkClaim>;
export function claimProvisioningWork(
  pool: pg.Pool,
  workId: string,
  options: { ifQueued: boolean },
): Promise<WorkClaim | undefined>;
export async function claimProvisioningWork(
  pool: pg.Pool,
  workId: string,
  { ifQueued = false }: { ifQueued?: boolean } = {},
): Promise<WorkClaim | undefined> {
  const claimToken = randomUUID();
  const claimed = await pool.query<{ idempotency_key: string }>(
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

export async function admitProvisioning(
  fixture: Pick<Fixture, "bootstrapNamespace" | "requestChecked">,
) {
  const namespace = await fixture.bootstrapNamespace();
  const secrets = await createProvisioningSecrets(fixture, namespace.id);
  const admitted = await requestAcceptedProvisioning(fixture, namespace.id, secrets);
  const provisioning = admitted.data.provisioning;
  assert.ok(provisioning.requestId);
  return { namespace, provisioning: { ...provisioning, requestId: provisioning.requestId } };
}
