import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Pool } from "pg";
import type { TSchema } from "typebox";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  AgentReadResponse,
  AgentResponse,
  ConfigurationResponse,
  ErrorResponse,
  isServiceAccountHarnessAuth,
  JsonValue,
  NamespaceResponse,
  PluginApproversSchema,
  PluginDesiredSelectionSchema,
  PluginDesiredStateSchema,
  PluginDriverIdentitySchema,
  PluginToolDefaultsSchema,
  PluginToolPolicySchema,
  type ChatGPTBackendDefinition,
  type ComputeDriver,
  type ConfigurationDriver,
  type HarnessAuthBinding,
  type Namespace,
  type SandboxDriver,
  type ServiceAccount,
  type ServiceAccountCredential,
} from "../../packages/contracts/src/index.ts";
import type {
  ControllerWorkState,
  OpenClawController,
  ServiceAccountReadRepository,
} from "../../packages/occ/src/index.ts";
import { createFixtureResponse } from "../helpers/console-fixture-response.ts";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { conformanceKubernetesOptions } from "../helpers/kubernetes-compute.mjs";
import { authenticatedHeaders, signInWithEmailPassword } from "../helpers/auth-session.mjs";
import {
  createConsoleFixtureTransport,
  fetchLoopback,
} from "../helpers/console-fixture-transport.ts";
import { jsonRequestInit } from "../helpers/inject-json.mjs";
import {
  alternateWorkspaceId,
  createAccessTokenServiceAccount,
  createBootstrappedBackendState,
  createBackendController,
  createBackendFixture,
  backendDefinition,
  backendId,
  requiresPostgres,
  seedBackendBinding,
  serviceAccountDriverId,
  startBackendlessDevelopmentServer,
  workspaceId,
} from "../helpers/postgres-backend-state.mjs";
import { reservePort } from "../helpers/available-port.ts";
import { stopProcess } from "../helpers/stop-process.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { assertSameAnswer, refusedAnswer } from "../helpers/refusal-answers.mjs";
import { claimIsolatedWork } from "../helpers/postgres-work-claim.mjs";
import {
  EMBEDDED_API_KEY_REQUIRED,
  SERVICE_ACCOUNT_BACKEND_MISMATCH,
  SERVICE_ACCOUNT_NO_BACKEND_BINDING,
} from "../helpers/refusal-text.mjs";

type BackendFixture = Awaited<ReturnType<typeof createBackendFixture>>;
type AuthSession = Awaited<ReturnType<typeof signInWithEmailPassword>>;
type AccountReference = Pick<ServiceAccount, "id" | "namespaceId">;
type BindingOverrides = Partial<
  NonNullable<Awaited<ReturnType<ServiceAccountReadRepository["findServiceAccountBackendBinding"]>>>
>;

const fixtureResponse = createFixtureResponse({
  SafeJsonValue: JsonValue,
  PluginApprovers: PluginApproversSchema,
  PluginDesiredSelection: PluginDesiredSelectionSchema,
  PluginDesiredState: PluginDesiredStateSchema,
  PluginDriverIdentity: PluginDriverIdentitySchema,
  PluginToolDefaults: PluginToolDefaultsSchema,
  PluginToolPolicy: PluginToolPolicySchema,
});

async function request<T extends TSchema>(
  origin: string,
  session: AuthSession,
  method: "GET" | "PATCH" | "POST",
  path: string,
  status: number,
  schema: T,
  body?: object,
) {
  const response = await fetchLoopback(`${origin}${path}`, {
    ...jsonRequestInit(method, body, {
      host: new URL(session.origin).host,
      ...authenticatedHeaders(session),
    }),
    signal: AbortSignal.timeout(5_000),
  });
  const payload: unknown = await response.json();
  return fixtureResponse(
    { status: response.status, body: payload },
    status,
    schema,
    `${method} ${path}`,
  );
}

async function createReadyNamespace(fixture: BackendFixture, label: string): Promise<Namespace> {
  const namespace: Namespace = {
    id: `ns_${randomUUID()}`,
    name: `backend-owner-${label}-${randomUUID()}`,
    status: "ready",
    createdAt: new Date().toISOString(),
  };
  await fixture.state.transact((unit) => unit.namespaces.createNamespace(namespace));
  fixture.track(namespace);
  return namespace;
}

async function createConfiguration(
  fixture: BackendFixture,
  controller: OpenClawController,
  namespace: Namespace,
  harness: "codex" | "openclaw" = "codex",
) {
  return controller.createConfiguration(fixture.actor.id, {
    namespaceId: namespace.id,
    kind: "agent",
    values: createHarnessConfiguration(harness, "gpt-4.1"),
  });
}

async function waitForWork(pool: Pool, revisionId: string, expected: ControllerWorkState) {
  const idempotencyKey = `agent_revision:${revisionId}:reconcile`;
  return waitFor(`controller work ${idempotencyKey} to become ${expected}`, async () => {
    const result = await pool.query<{ state: ControllerWorkState; attempt_count: number }>(
      "SELECT state, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
      [idempotencyKey],
    );
    const work = result.rows[0];
    return work?.state === expected ? work : undefined;
  });
}

async function assertNoRevision(pool: Pool, namespaceId: string, agentId: string, label: string) {
  const result = await pool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM occ.agent_revisions WHERE namespace_id = $1 AND agent_id = $2",
    [namespaceId, agentId],
  );
  assert.deepEqual(result.rows, [{ count: 0 }], label);
}

async function assertNoAgentNamed(pool: Pool, namespaceId: string, name: string, label: string) {
  const result = await pool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM occ.agents WHERE namespace_id = $1 AND name = $2",
    [namespaceId, name],
  );
  assert.deepEqual(result.rows, [{ count: 0 }], label);
}

// `expected` is the exact message, or a pattern for messages this file does not own.
async function expectBackendConflict(
  operation: () => Promise<unknown>,
  expected: string | RegExp,
  name: string,
) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, name, error.message);
    if (typeof expected === "string") {
      assert.equal(error.message, expected);
    } else {
      assert.match(error.message, expected);
    }
    return true;
  });
}

test(
  "development API starts with stale Backend references and permits repair through Agent update",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    // Hold the private transport port until the child binds it, and again
    // across the restart, so no other socket takes it in between.
    let reservation = await reservePort();
    context.after(() => reservation.release());
    const { port } = reservation;
    const origin = `http://127.0.0.1:${port}`;
    const authBaseURL = "https://console.oce.localhost";
    const transport = createConsoleFixtureTransport(authBaseURL, origin);
    const email = "postgres-admin@openclaw.local";
    const password = "postgres-development-password";
    const authSecret = "openclaw-backend-repair-auth-secret-minimum-32-bytes";
    const fixture = await createBootstrappedBackendState(context, {
      email,
      password,
      authSecret,
      authBaseURL,
      installationName: "PostgreSQL Backend repair integration",
    });
    const server = await startBackendlessDevelopmentServer(context, {
      reservation,
      authBaseURL,
      authSecret,
      configurationRoot: fixture.configurationRoot,
    });
    const signIn = () =>
      signInWithEmailPassword({
        fetch: (input, init) => transport.fetchThroughLoopback(new Request(input, init)),
        origin: authBaseURL,
        email,
        password,
        rememberMe: undefined,
      });
    const session = await signIn();

    const { data: namespace } = await request(
      origin,
      session,
      "POST",
      "/namespaces",
      201,
      NamespaceResponse,
      {
        name: `backend-repair-${randomUUID()}`,
      },
    );
    fixture.track(namespace);
    await fixture.state.transact((unit) =>
      unit.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
    );
    const { data: configuration } = await request(
      origin,
      session,
      "POST",
      `/namespaces/${namespace.id}/configurations`,
      201,
      ConfigurationResponse,
      {
        kind: "agent",
        values: createHarnessConfiguration("codex", "gpt-4.1"),
      },
    );
    const { data: agent } = await request(
      origin,
      session,
      "POST",
      `/namespaces/${namespace.id}/agents`,
      201,
      AgentResponse,
      {
        name: `backend-repair-${randomUUID()}`,
        configurationId: configuration.id,
        executionMode: "dedicated",
      },
    );

    reservation = await reservePort({ port });
    await stopProcess(server.child);
    await fixture.pool.query(
      "UPDATE occ.agents SET backend_id = $1 WHERE namespace_id = $2 AND id = $3",
      [backendId, namespace.id, agent.id],
    );

    await startBackendlessDevelopmentServer(context, {
      reservation,
      authBaseURL,
      authSecret,
      configurationRoot: fixture.configurationRoot,
    });
    const restartedSession = await signIn();
    const { data: visible } = await request(
      origin,
      restartedSession,
      "GET",
      `/namespaces/${namespace.id}/agents/${agent.id}`,
      200,
      AgentReadResponse,
    );
    assert.equal(visible.backendId, backendId);

    // Startup must allow API repair. Deploying a stale Backend reference is rejected
    // through the API's canonical unknown-reference response before admission.
    const deploy = await request(
      origin,
      restartedSession,
      "POST",
      `/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
      404,
      ErrorResponse,
    );
    assert.equal(deploy.error.code, "NOT_FOUND");
    await assertNoRevision(
      fixture.pool,
      namespace.id,
      agent.id,
      "stale Backend deployment must be rejected before an AgentRevision is persisted",
    );

    const { data: repaired } = await request(
      origin,
      restartedSession,
      "PATCH",
      `/namespaces/${namespace.id}/agents/${agent.id}`,
      200,
      AgentResponse,
      {
        configurationId: configuration.id,
        backendId: null,
        harnessAuth: null,
        executionMode: "dedicated",
      },
    );
    assert.equal(repaired.backendId, null);

    const persisted = await fixture.pool.query<{
      backend_id: string | null;
      harness_auth: HarnessAuthBinding | null;
    }>("SELECT backend_id, harness_auth FROM occ.agents WHERE namespace_id = $1 AND id = $2", [
      namespace.id,
      agent.id,
    ]);
    assert.deepEqual(persisted.rows, [{ backend_id: null, harness_auth: null }]);
  },
);

test(
  "PostgreSQL Backend ownership persists exact Agent associations and admits only matching managed bindings",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const fixture = await createBackendFixture(context);
    const controller = createBackendController(fixture, { nativeWorkerSupport: "custom-image" });

    const draftNamespace = await verifyDraftAssociation(fixture, controller);
    const exactNamespace = await verifyManagedDeploymentAndRetirement(fixture, controller);
    await fixture.cleanup(draftNamespace, exactNamespace);
    await verifyMismatchedBindings(fixture, controller);
    await verifyCrossNamespaceRefusal(fixture, controller);
  },
);

async function verifyDraftAssociation(fixture: BackendFixture, controller: OpenClawController) {
  const draftNamespace = await createReadyNamespace(fixture, "drafts");
  const draftConfiguration = await createConfiguration(fixture, controller, draftNamespace);
  const backendless = await controller.createAgent(fixture.actor.id, {
    namespaceId: draftNamespace.id,
    name: `backendless-${randomUUID()}`,
    configurationId: draftConfiguration.id,
  });
  assert.equal(backendless.backendId, null);
  const selected = await controller.updateAgent(fixture.actor.id, {
    namespaceId: draftNamespace.id,
    agentId: backendless.id,
    configurationId: draftConfiguration.id,
    backendId,
  });
  assert.equal(selected.backendId, backendId);
  const cleared = await controller.updateAgent(fixture.actor.id, {
    namespaceId: draftNamespace.id,
    agentId: backendless.id,
    configurationId: draftConfiguration.id,
    backendId: null,
  });
  assert.equal(cleared.backendId, null);
  const draftRows = await fixture.pool.query<{ backend_id: string | null }>(
    "SELECT backend_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
    [draftNamespace.id, backendless.id],
  );
  assert.deepEqual(draftRows.rows, [{ backend_id: null }]);
  return draftNamespace;
}

async function verifyManagedDeploymentAndRetirement(
  fixture: BackendFixture,
  controller: OpenClawController,
): Promise<Namespace> {
  const exactNamespace = await createReadyNamespace(fixture, "exact");
  const dedicatedConfiguration = await createConfiguration(fixture, controller, exactNamespace);
  const embeddedConfiguration = await createConfiguration(
    fixture,
    controller,
    exactNamespace,
    "openclaw",
  );
  const account: ServiceAccount = await createAccessTokenServiceAccount(
    fixture.state,
    exactNamespace.id,
    "exact",
  );
  await seedBackendBinding(fixture.pool, account);

  const binding = await fixture.state.read((view) =>
    view.serviceAccounts.findServiceAccountBackendBinding(exactNamespace.id, account.id),
  );
  assert.deepEqual(binding, {
    backendId,
    driverId: serviceAccountDriverId,
    workspaceId,
    credentialIssued: true,
  });

  const managedAuth = {
    method: "codex_pat",
    source: { kind: "service_account", namespaceId: account.namespaceId, id: account.id },
  } satisfies HarnessAuthBinding;
  const dedicated = await controller.createAgent(fixture.actor.id, {
    namespaceId: exactNamespace.id,
    name: `dedicated-${randomUUID()}`,
    configurationId: dedicatedConfiguration.id,
    backendId,
    harnessAuth: managedAuth,
    executionMode: "dedicated",
  });
  const admitted = await controller.deployAgent(
    fixture.actor.id,
    { namespaceId: exactNamespace.id, agentId: dedicated.id },
    resolveApprovedHarness,
  );
  assert.equal(admitted.backendId, backendId);
  assert.deepEqual(admitted.harnessAuth, {
    ...managedAuth,
    credential: account.credential,
    backendBinding: binding,
  });

  const secretDriver = createTestSecretDriver({ id: "secret-test" });
  controller.registerDriver(secretDriver);
  controller.selectDriver("secret", secretDriver.id);
  const { worker, calls } = fixture.startWorker({ secretDriver });
  await worker.start();
  await waitForWork(fixture.pool, admitted.id, "succeeded");
  assert.deepEqual(calls, [{ action: "prepare", revisionId: admitted.id, backendId }]);
  const persistedRevision = await fixture.pool.query<{
    agent_backend_id: string | null;
    revision_backend_id: string | null;
    admitted_spec_has_backend_id: boolean;
  }>(
    `SELECT a.backend_id AS agent_backend_id,
            r.backend_id AS revision_backend_id,
            r.admitted_spec ? 'backend_id' AS admitted_spec_has_backend_id
     FROM occ.agents AS a
     JOIN occ.agent_revisions AS r
       ON r.namespace_id = a.namespace_id AND r.agent_id = a.id
     WHERE a.namespace_id = $1 AND a.id = $2 AND r.id = $3`,
    [exactNamespace.id, dedicated.id, admitted.id],
  );
  assert.deepEqual(persistedRevision.rows, [
    {
      agent_backend_id: backendId,
      revision_backend_id: backendId,
      admitted_spec_has_backend_id: false,
    },
  ]);

  const embedded = await controller.createAgent(fixture.actor.id, {
    namespaceId: exactNamespace.id,
    name: `embedded-${randomUUID()}`,
    configurationId: embeddedConfiguration.id,
    backendId,
    harnessAuth: managedAuth,
    executionMode: "embedded",
  });
  // The method is the Agent's own setting, so deployment names it (a 400 over HTTP).
  await expectBackendConflict(
    () =>
      controller.deployAgent(
        fixture.actor.id,
        { namespaceId: exactNamespace.id, agentId: embedded.id },
        resolveApprovedHarness,
      ),
    EMBEDDED_API_KEY_REQUIRED,
    "ConfigurationHarnessError",
  );
  await assertNoRevision(
    fixture.pool,
    exactNamespace.id,
    embedded.id,
    "embedded OpenClaw must be denied before a managed-account revision is persisted",
  );

  const sameIdentity = createBackendController(fixture, {
    backends: [
      backendDefinition({
        apiKeyPath: "/etc/openclaw/chatgpt/rotated-admin-key",
        credentialTtlSeconds: 60,
      }),
    ],
  });
  await sameIdentity.validateBackendConfiguration();

  await controller.updateAgent(fixture.actor.id, {
    namespaceId: exactNamespace.id,
    agentId: embedded.id,
    configurationId: embeddedConfiguration.id,
    backendId: null,
    harnessAuth: null,
    executionMode: "embedded",
  });
  const independentConfiguration = await createConfiguration(fixture, controller, exactNamespace);
  const replacementSecret = await controller.createSecret(fixture.actor.id, {
    namespaceId: exactNamespace.id,
    name: `independent-key-${randomUUID()}`,
    value: "synthetic-backend-independent-key",
  });
  const replacementAuth = {
    method: "api_key",
    source: { kind: "secret", namespaceId: exactNamespace.id, id: replacementSecret.id },
  } satisfies HarnessAuthBinding;
  const roleId = `harness-key-${randomUUID()}`;
  await fixture.pool.query(
    `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [
      roleId,
      exactNamespace.id,
      roleId,
      JSON.stringify([{ action: "operate", resourceKind: "secret" }]),
    ],
  );
  await fixture.pool.query(
    `INSERT INTO occ.iam_access_bindings
       (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id)
     VALUES ($1, $2, $3, $4, 'secret', $5)`,
    [
      `binding-${randomUUID()}`,
      exactNamespace.id,
      dedicated.servicePrincipalId,
      roleId,
      replacementSecret.id,
    ],
  );
  const independent = await controller.updateAgent(fixture.actor.id, {
    namespaceId: exactNamespace.id,
    agentId: dedicated.id,
    configurationId: independentConfiguration.id,
    backendId: null,
    harnessAuth: replacementAuth,
    executionMode: "dedicated",
  });
  assert.equal(independent.backendId, null);
  assert.deepEqual(independent.harnessAuth, replacementAuth);
  const replacement = await controller.deployAgent(
    fixture.actor.id,
    { namespaceId: exactNamespace.id, agentId: dedicated.id },
    resolveApprovedHarness,
  );
  assert.equal(replacement.backendId, null);
  assert.deepEqual(replacement.harnessAuth, {
    ...replacementAuth,
    secretDriverId: secretDriver.id,
  });
  await waitForWork(fixture.pool, replacement.id, "succeeded");
  assert.deepEqual(calls, [
    { action: "prepare", revisionId: admitted.id, backendId },
    { action: "prepare", revisionId: replacement.id, backendId: null },
    { action: "retire", revisionId: admitted.id, backendId },
  ]);

  // A supported native-worker Sandbox lets both PAT sources reach the real
  // Kubernetes topology validator; neither may become an OpenClaw deployment.
  const sandbox: SandboxDriver = {
    id: "sandbox-native-pat-admission",
    implementation: "test/native-worker",
    capability: "sandbox",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets: ["networking", "filesystem", "process"],
    async provisionHarness() {
      assert.fail("Refused admission must not provision a Sandbox.");
    },
    async cleanup() {},
  };
  const kubernetes = new KubernetesComputeDriver(
    conformanceKubernetesOptions({ gatewayTrustedProxyCidrs: ["127.0.0.1/32"] }),
    { sandboxDriver: sandbox },
  );
  controller.selectedDriver("compute").validateHarnessAuth =
    kubernetes.validateHarnessAuth.bind(kubernetes);
  controller.registerDriver(sandbox);
  controller.selectDriver("sandbox", sandbox.id);
  const admissionCounts = async () =>
    (
      await fixture.pool.query<{ revisions: number; work: number }>(
        `SELECT
           (SELECT count(*)::integer FROM occ.agent_revisions WHERE namespace_id=$1 AND agent_id=$2) AS revisions,
           (SELECT count(*)::integer FROM occ.controller_work WHERE namespace_id=$1) AS work`,
        [exactNamespace.id, dedicated.id],
      )
    ).rows;
  const beforeNativeAttempts = await admissionCounts();
  assert.ok(isServiceAccountHarnessAuth(dedicated.harnessAuth));
  const patAttempts: readonly Extract<HarnessAuthBinding, { method: "codex_pat" }>[] = [
    { method: "codex_pat", source: dedicated.harnessAuth.source },
    { method: "codex_pat", source: replacementAuth.source },
  ];
  for (const harnessAuth of patAttempts) {
    await controller.updateAgent(fixture.actor.id, {
      namespaceId: exactNamespace.id,
      agentId: dedicated.id,
      configurationId: embeddedConfiguration.id,
      backendId: harnessAuth.source.kind === "service_account" ? backendId : null,
      harnessAuth,
      executionMode: "dedicated",
    });
    await expectBackendConflict(
      () =>
        controller.deployAgent(
          fixture.actor.id,
          { namespaceId: exactNamespace.id, agentId: dedicated.id },
          resolveApprovedHarness,
        ),
      /^Agent setting harnessAuth\.method must be api_key or credential_source for Dedicated OpenClaw on Kubernetes Compute/,
      "ConfigurationHarnessError",
    );
    assert.deepEqual(await admissionCounts(), beforeNativeAttempts, harnessAuth.source.kind);
  }

  const deletedAccount = await fixture.state.transact((unit) =>
    unit.serviceAccounts.deleteServiceAccount(exactNamespace.id, account.id),
  );
  assert.equal(deletedAccount, true);
  const oldRevision = await fixture.state.read((view) =>
    view.revisions.findRevision(exactNamespace.id, dedicated.id, admitted.id),
  );
  assert.equal(oldRevision?.backendId, backendId);
  assert.deepEqual(oldRevision?.harnessAuth, admitted.harnessAuth);
  const activeReplacement = await fixture.pool.query<{ active_revision_id: string | null }>(
    "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
    [exactNamespace.id, dedicated.id],
  );
  assert.deepEqual(activeReplacement.rows, [{ active_revision_id: replacement.id }]);
  await createBackendController(fixture, { backends: [] }).validateBackendConfiguration();

  return exactNamespace;
}

async function verifyMismatchedBindings(fixture: BackendFixture, controller: OpenClawController) {
  const scenarios: readonly {
    label: string;
    agentBackendId: string | null;
    binding: BindingOverrides;
    message: string;
  }[] = [
    {
      label: "backendless",
      agentBackendId: null,
      binding: {},
      message: SERVICE_ACCOUNT_NO_BACKEND_BINDING,
    },
    {
      label: "backend-mismatch",
      agentBackendId: backendId,
      binding: { backendId: "other-backend" },
      message: SERVICE_ACCOUNT_BACKEND_MISMATCH,
    },
    {
      label: "driver-mismatch",
      agentBackendId: backendId,
      binding: { driverId: "other-service-account-driver" },
      message: SERVICE_ACCOUNT_BACKEND_MISMATCH,
    },
    {
      label: "workspace-mismatch",
      agentBackendId: backendId,
      binding: { workspaceId: alternateWorkspaceId },
      message: SERVICE_ACCOUNT_BACKEND_MISMATCH,
    },
    {
      label: "credential-not-issued",
      agentBackendId: backendId,
      binding: { credentialIssued: false },
      message: SERVICE_ACCOUNT_BACKEND_MISMATCH,
    },
  ];
  for (const scenario of scenarios) {
    const namespace = await createReadyNamespace(fixture, scenario.label);
    const configuration = await createConfiguration(fixture, controller, namespace);
    const brokenAccount: ServiceAccount = await createAccessTokenServiceAccount(
      fixture.state,
      namespace.id,
      scenario.label,
    );
    await seedBackendBinding(fixture.pool, brokenAccount, scenario.binding);
    const agent = await controller.createAgent(fixture.actor.id, {
      namespaceId: namespace.id,
      name: `${scenario.label}-${randomUUID()}`,
      configurationId: configuration.id,
      backendId: scenario.agentBackendId,
      harnessAuth: {
        method: "codex_pat",
        source: {
          kind: "service_account",
          namespaceId: brokenAccount.namespaceId,
          id: brokenAccount.id,
        },
      },
      executionMode: "dedicated",
    });
    await expectBackendConflict(
      () =>
        controller.deployAgent(
          fixture.actor.id,
          { namespaceId: namespace.id, agentId: agent.id },
          resolveApprovedHarness,
        ),
      scenario.message,
      "ServiceAccountBackendBindingError",
    );
    await assertNoRevision(
      fixture.pool,
      namespace.id,
      agent.id,
      `${scenario.label} must be rejected before an AgentRevision is persisted`,
    );
    await fixture.cleanup(namespace);
  }
}

async function verifyCrossNamespaceRefusal(
  fixture: BackendFixture,
  controller: OpenClawController,
) {
  const targetNamespace = await createReadyNamespace(fixture, "cross-namespace-target");
  const sourceNamespace = await createReadyNamespace(fixture, "cross-namespace-source");
  const [targetConfiguration, sourceAccount] = await Promise.all([
    createConfiguration(fixture, controller, targetNamespace),
    createAccessTokenServiceAccount(fixture.state, sourceNamespace.id, "cross-source"),
  ]);
  await seedBackendBinding(fixture.pool, sourceAccount);
  assert.equal(
    await fixture.state.read((view) =>
      view.serviceAccounts.findServiceAccountBackendBinding(targetNamespace.id, sourceAccount.id),
    ),
    undefined,
    "the private Backend binding view must not resolve bindings across Namespaces",
  );
  const crossNamespaceAgentName = `cross-namespace-${randomUUID()}`;
  await assert.rejects(
    () =>
      controller.createAgent(fixture.actor.id, {
        namespaceId: targetNamespace.id,
        name: crossNamespaceAgentName,
        configurationId: targetConfiguration.id,
        backendId,
        harnessAuth: {
          method: "codex_pat",
          source: {
            kind: "service_account",
            namespaceId: targetNamespace.id,
            id: sourceAccount.id,
          },
        },
        executionMode: "dedicated",
      }),
    (error) =>
      error instanceof Error &&
      error.name === "ScopeViolationError" &&
      /ServiceAccount does not belong to the exact Namespace/.test(error.message),
  );
  await assertNoAgentNamed(
    fixture.pool,
    targetNamespace.id,
    crossNamespaceAgentName,
    "cross-Namespace account ownership must be rejected before an Agent is persisted",
  );
  await fixture.cleanup(targetNamespace, sourceNamespace);
}

test(
  "PostgreSQL Agent provisioning admits a managed PAT source only with an issued access token matching its Backend",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const fixture = await createBackendFixture(context);
    // These stubs only pass the provisioning capability gates; Harness authentication admission
    // (the code under test) stays real. No runtime or Configuration effect may run.
    const stubbedController = (backends?: readonly ChatGPTBackendDefinition[]) => {
      const controller = createBackendController(fixture, {
        nativeWorkerSupport: "custom-image",
        backends,
      });
      Object.assign(controller.selectedDriver("compute"), {
        agentProvisioning: { executionModes: ["dedicated"] },
        requiresAgentRuntimeCredentials: true,
        validateAgentProvisioning() {},
        async provisionAgentRuntimeCredentials() {
          assert.fail("Provisioning admission must not provision runtime credentials.");
        },
        async getAgentRuntimeCredentialStatus() {
          return { transportConfigured: false };
        },
      } satisfies Pick<
        ComputeDriver,
        | "agentProvisioning"
        | "requiresAgentRuntimeCredentials"
        | "validateAgentProvisioning"
        | "provisionAgentRuntimeCredentials"
        | "getAgentRuntimeCredentialStatus"
      >);
      Object.assign(controller.selectedDriver("configuration"), {
        async createExact() {
          assert.fail("Provisioning admission must not create a Configuration.");
        },
        async inspectExact() {
          assert.fail("Provisioning admission must not inspect a Configuration.");
        },
      } satisfies Pick<ConfigurationDriver, "createExact" | "inspectExact">);
      return controller;
    };
    const controller = stubbedController();
    const provision = (namespace: Namespace, account: AccountReference, label: string) =>
      controller.provisionAgent(fixture.actor.id, {
        namespaceId: namespace.id,
        requestId: `req_${randomUUID()}`,
        name: `${label}-${randomUUID().slice(0, 8)}`,
        executionMode: "dedicated",
        backendId,
        configuration: { kind: "agent", values: createHarnessConfiguration("codex", "gpt-4.1") },
        harnessAuth: {
          method: "codex_pat",
          source: { kind: "service_account", namespaceId: account.namespaceId, id: account.id },
        },
      });
    const pendingWork = async (namespace: Namespace) => {
      const {
        rows: [row],
      } = await fixture.pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM occ.agent_provisioning_work WHERE namespace_id = $1",
        [namespace.id],
      );
      assert.ok(row, "the provisioning count query must return a row");
      return row.count;
    };

    // The exact issued account with a matching Backend binding is admitted as a PAT snapshot.
    const exactNamespace = await createReadyNamespace(fixture, "provisioning-exact");
    const account: ServiceAccount = await createAccessTokenServiceAccount(
      fixture.state,
      exactNamespace.id,
      "provisioning-exact",
    );
    await seedBackendBinding(fixture.pool, account);
    const accepted = await provision(exactNamespace, account, "provisioning-exact");
    assert.equal(accepted.provisioning.status, "queued", JSON.stringify(accepted));
    assert.equal(await pendingWork(exactNamespace), 1);
    // The job checks the binding again: after the Installation's ChatGPT Backend moves to another
    // workspace, it fails with the same named text in its status, not the generic one.
    const movedBackend = backendDefinition({ workspaceId: alternateWorkspaceId });
    const { type } = movedBackend;
    assert.ok(type === "chatgpt");
    const moved = stubbedController([{ ...movedBackend, type }]);
    const { workId } = accepted.provisioning;
    const claim = await claimIsolatedWork(fixture.pool, { workId });
    assert.ok(claim, "the admitted provisioning job must be claimed from the queue");
    assert.equal(claim.idempotencyKey, workId);
    const outcome = await moved.processAgentProvisioning(claim, resolveApprovedHarness);
    assert.equal(outcome.outcome, "permanent", JSON.stringify(outcome));
    const job = await fixture.pool.query<{ error: unknown }>(
      "SELECT progress->'error' AS error FROM occ.agent_provisioning_work WHERE work_id = $1",
      [workId],
    );
    assert.deepEqual(job.rows, [
      { error: { code: "PROVISIONING_REJECTED", message: SERVICE_ACCOUNT_BACKEND_MISMATCH } },
    ]);
    await fixture.cleanup(exactNamespace);

    const scenarios: readonly {
      label: string;
      credential?: ServiceAccountCredential;
      binding: BindingOverrides;
      message: RegExp | string;
      expectedErrorName?: string;
    }[] = [
      {
        label: "api-key-credential",
        credential: { kind: "api_key", secretRef: { name: "provider-api-key", key: "api-key" } },
        binding: {},
        message: /requires an issued account access-token credential/,
        expectedErrorName: "ResourceStateConflictError",
      },
      {
        label: "workspace-mismatch",
        binding: { workspaceId: alternateWorkspaceId },
        message: SERVICE_ACCOUNT_BACKEND_MISMATCH,
      },
      {
        label: "credential-not-issued",
        binding: { credentialIssued: false },
        message: SERVICE_ACCOUNT_BACKEND_MISMATCH,
      },
    ];
    for (const scenario of scenarios) {
      const namespace = await createReadyNamespace(fixture, scenario.label);
      const brokenAccount: ServiceAccount = await createAccessTokenServiceAccount(
        fixture.state,
        namespace.id,
        scenario.label,
      );
      const { credential } = scenario;
      if (credential !== undefined) {
        await fixture.state.transact((unit) =>
          unit.serviceAccounts.updateCredential(namespace.id, brokenAccount.id, credential),
        );
      }
      await seedBackendBinding(fixture.pool, brokenAccount, scenario.binding);
      await expectBackendConflict(
        () => provision(namespace, brokenAccount, scenario.label),
        scenario.message,
        scenario.expectedErrorName ?? "ServiceAccountBackendBindingError",
      );
      assert.equal(
        await pendingWork(namespace),
        0,
        `${scenario.label} must roll back its provisioning record`,
      );
      await fixture.cleanup(namespace);
    }

    // A Restriction denies ServiceAccount read in this Namespace. The read check runs before the
    // account and its Backend binding are looked up, so the caller gets one denial for a
    // mismatched account and for an ID that names none, never the 409 (finding 2624). OCC has no
    // API that writes Restrictions, so insert it directly.
    const restricted = await createReadyNamespace(fixture, "provisioning-restricted");
    const hidden: ServiceAccount = await createAccessTokenServiceAccount(
      fixture.state,
      restricted.id,
      "provisioning-restricted",
    );
    await seedBackendBinding(fixture.pool, hidden, { workspaceId: alternateWorkspaceId });
    await fixture.pool.query(
      `INSERT INTO occ.iam_restrictions (id, namespace_id, action, resource_kind, resource_id)
       VALUES ($1, $2, 'read', 'service_account', NULL)`,
      [`restriction_${randomUUID()}`, restricted.id],
    );
    await assertSameAnswer(
      (id: string) =>
        refusedAnswer(
          () => provision(restricted, { namespaceId: restricted.id, id }, "restricted"),
          { requested: (value: string) => value === id, actorId: fixture.actor.id },
        ),
      [hidden.id, `sa_${randomUUID()}`],
    );
    assert.equal(await pendingWork(restricted), 0);
    await fixture.cleanup(restricted);
  },
);
