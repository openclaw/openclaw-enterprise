import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { Pool, PoolClient } from "pg";

import { betterAuthIssuer, humanLoginConfiguration } from "../../apps/controller/src/auth/index.ts";
import { OAuthAccountTokens } from "../../apps/controller/src/backends/token-service/oauth-connection.ts";
import { OCCTokenServiceDriver } from "../../apps/controller/src/drivers/token-service/occ.ts";
import { initializeInstallationPresets } from "../../apps/controller/src/composition/installation-config.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import { createFastifyApp, type ControllerAppOptions } from "../../apps/controller/src/index.ts";
import type {
  Agent,
  Permission,
  PresetDraftDefinition,
} from "../../packages/contracts/src/index.ts";
import { NativeIAMDriver, validateAuthAccountPrincipalSeed } from "../../packages/iam/src/index.ts";
import {
  OpenClawController,
  PostgresHumanAuthentication,
  type ControllerOptions,
  type InstallationIAMConfiguration,
} from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.ts";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { waitForLockWaiter } from "../helpers/postgres-locks.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { createPostgresControllerAuth } from "../helpers/password-hasher.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { changeAccount, fixtureOidcIssuer } from "../helpers/production-sign-in.mjs";

const configurationLock = "occ:iam-configuration";
const issuer = "https://oauth.durable-authority.test";
const tokenUrl = issuer + "/token";
const publicOrigin = "https://console.oce.localhost";
const authorityPermissions: readonly Permission[] = [
  { resourceKind: "credential_source", action: "create" },
  { resourceKind: "agent", action: "administer" },
  { resourceKind: "preset", action: "create" },
];
const ordinaryPermissions: readonly Permission[] = [
  { resourceKind: "namespace", action: "read" },
  { resourceKind: "configuration", action: "read" },
  { resourceKind: "secret", action: "read" },
  { resourceKind: "secret", action: "operate" },
  { resourceKind: "agent", action: "read" },
  { resourceKind: "agent", action: "update" },
  { resourceKind: "agent", action: "deploy" },
];
const ownerPermissions: readonly Permission[] = [
  { resourceKind: "preset", action: "read" },
  { resourceKind: "preset", action: "update" },
  { resourceKind: "preset", action: "delete" },
];

function policy(authority: boolean, independentCreate = false): InstallationIAMConfiguration {
  return {
    roles: [
      {
        id: "durable-authority",
        permissions: authority
          ? authorityPermissions
          : [{ resourceKind: "namespace", action: "read" }],
      },
      {
        id: "durable-ordinary",
        permissions: [
          ...ordinaryPermissions,
          ...(independentCreate
            ? [{ resourceKind: "preset" as const, action: "create" as const }]
            : []),
        ],
      },
      { id: "durable-owner", permissions: ownerPermissions },
    ],
    defaultUserGroups: ["durable-callers"],
    ownerRole: "durable-owner",
    roleBindings: [
      { group: "durable-callers", role: "durable-authority", scope: "installation" },
      { group: "durable-callers", role: "durable-ordinary", scope: "installation" },
    ],
  };
}

type HttpResult = { statusCode: number; body: string; json(): unknown };
function data<T>(response: HttpResult, status: number): T {
  assert.equal(response.statusCode, status, response.body);
  const result = response.json() as { data?: T };
  assert.ok(result.data);
  return result.data;
}

function tracked<T>(operation: Promise<T>): Promise<T> {
  void operation.catch(() => {});
  return operation;
}

async function holder(pool: Pool, sql: string, parameters: unknown[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const row = result.rows[0];
    assert.ok(row);
    await client.query(sql, parameters);
    return { client, pid: row.pid };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    client.release(true);
    throw error;
  }
}

async function release(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
}

// Observe PostgreSQL's actual wait graph. The paused transaction owns a real resource
// lock; no authorization result, transaction body, or State method is replaced.
async function authorityFirst<T>(
  pool: Pool,
  namespaceId: string,
  start: () => Promise<T>,
  withdraw: () => Promise<void>,
): Promise<T> {
  const blocked = await holder(pool, "SELECT id FROM occ.namespaces WHERE id = $1 FOR UPDATE", [
    namespaceId,
  ]);
  let command: Promise<T> | undefined;
  let withdrawal: Promise<void> | undefined;
  try {
    command = tracked(start());
    const commandPid = await waitForLockWaiter(
      pool,
      blocked.pid,
      "authority writer reaches its Namespace",
      {
        queryLike: "%FROM occ.namespaces%FOR UPDATE%",
        timeoutMs: 5000,
      },
    );
    withdrawal = tracked(withdraw());
    await waitForLockWaiter(
      pool,
      commandPid,
      "configured-policy writer waits for authority COMMIT",
      {
        queryLike: "%pg_advisory_xact_lock%",
        timeoutMs: 5000,
      },
    );
  } finally {
    await release(blocked.client);
    await Promise.allSettled([command, withdrawal]);
  }
  assert.ok(command !== undefined);
  assert.ok(withdrawal !== undefined);
  const result = await command;
  await withdrawal;
  return result;
}

async function withdrawalFirst<T>(
  pool: Pool,
  start: () => Promise<T>,
  withdraw: () => Promise<void>,
): Promise<T> {
  const blocked = await holder(pool, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    configurationLock,
  ]);
  let command: Promise<T> | undefined;
  let withdrawal: Promise<void> | undefined;
  try {
    withdrawal = tracked(withdraw());
    const writerPid = await waitForLockWaiter(
      pool,
      blocked.pid,
      "configured withdrawal queues first",
      {
        queryLike: "%pg_advisory_xact_lock%",
        timeoutMs: 5000,
      },
    );
    command = tracked(start());
    await waitForLockWaiter(
      pool,
      writerPid,
      "authority request queues behind configuration withdrawal",
      {
        queryLike: "%pg_advisory_xact_lock_shared%",
        timeoutMs: 5000,
      },
    );
  } finally {
    await release(blocked.client);
    await Promise.allSettled([withdrawal, command]);
  }
  assert.ok(command !== undefined);
  assert.ok(withdrawal !== undefined);
  await withdrawal;
  return command;
}

async function createFixture(t: TestContext) {
  const secretDriver = createTestSecretDriver();
  const fixture = await createPostgresAgentApp(t, {
    label: "durable-authority",
    authSecret: "durable-authority-fixture-session-secret",
    poolOptions: { max: 10, connectionTimeoutMillis: 5000 },
    secretDriver,
    controllerOptions: { iamConfiguration: policy(true) },
    appOptions: {
      publicOrigin,
      provisionAuthAccount: (...args: Parameters<typeof provision>) => provision(...args),
    },
  });
  const { controller, state, pool, app, inject } = fixture;
  const iam = controller.selectedDriver("iam");
  assert.ok(iam instanceof NativeIAMDriver);
  const authentication = new PostgresHumanAuthentication(
    state,
    controller.installation.id,
    betterAuthIssuer(controller.installation.id),
  );
  const provision: NonNullable<ControllerAppOptions["provisionAuthAccount"]> = async (
    seed,
    audit,
    prepared,
    external,
  ) => {
    validateAuthAccountPrincipalSeed(
      seed,
      await state.loadNativeIAMState(controller.installation.id),
      controller.installation.id,
    );
    await authentication.provisionPasswordAccount(prepared, seed, audit, external);
  };
  const instanceId = await controller.activateTokenServiceInstance("durable-oauth", randomUUID());
  const tokenOwner = new OCCTokenServiceDriver(
    "durable-oauth",
    controller.installation.id,
    secretDriver.installationSecrets,
    instanceId,
    state,
    undefined,
    new OAuthAccountTokens(
      state,
      secretDriver,
      controller.resolveConnectionClient.bind(controller),
    ),
  );
  controller.registerDriver(tokenOwner);
  controller.selectDriver("token_service", tokenOwner.id);
  await controller.applyIAMConfiguration();

  const administratorRoles = await pool.query<{ role_id: string }>(
    `SELECT b.role_id
     FROM occ.iam_access_bindings b JOIN occ.iam_roles r ON r.id = b.role_id
     WHERE b.identity_subject_id = $1 AND r.namespace_id IS NULL
       AND r.id LIKE 'role_admin_%'`,
    [fixture.principal.id],
  );
  assert.equal(administratorRoles.rows.length, 1);
  const administratorRole = administratorRoles.rows[0];
  assert.ok(administratorRole);

  const email = `durable-${randomUUID()}@example.test`;
  const password = randomUUID();
  const account = data<{ principalId: string; id: string }>(
    await inject("POST", "/api/auth/accounts", {
      name: "Durable authority",
      email,
      password,
      roleId: administratorRole.role_id,
    }),
    201,
  );
  const actor = (await state.loadNativeIAMState()).identities.find(
    (identity) => identity.id === account.principalId,
  );
  assert.ok(actor && actor.kind === "principal");
  assert.equal(
    (
      await iam.authorize({
        principalId: actor.id,
        action: "administer",
        resource: { kind: "installation", id: controller.installation.id },
      })
    ).allowed,
    true,
  );
  const session = await signInToControllerApp(app, { email, password });
  const request = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    body?: object,
    target = app,
  ) =>
    target.inject({
      method,
      url,
      headers: { host: new URL(session.origin).host, ...authenticatedHeaders(session) },
      ...(body === undefined ? {} : { payload: body }),
    });

  function controllerWith(
    iamConfiguration: InstallationIAMConfiguration,
    extra: ControllerOptions = {},
    repositoryAdmission?: Parameters<typeof OpenClawController.forInstallation>[2],
  ) {
    const next = OpenClawController.forInstallation(
      controller.installation,
      {
        state,
        iamConfiguration,
        recordOperations: false,
        ...extra,
      },
      repositoryAdmission,
    );
    for (const capability of [
      "iam",
      "compute",
      "configuration",
      "secret",
      "token_service",
    ] as const) {
      const driver = controller.selectedDriver(capability);
      next.registerDriver(driver);
      next.selectDriver(capability, driver.id);
    }
    return next;
  }
  const auth = await createPostgresControllerAuth({
    mode: "development",
    installationId: controller.installation.id,
    baseURL: publicOrigin,
    agentDomain: "agents.oce.localhost",
    secret: "durable-authority-fixture-session-secret",
    pool,
    state,
    iamDriver: iam,
  });
  const createApp = (selectedController: OpenClawController, selectedAuth = auth) => {
    const created = createFastifyApp({
      controller: selectedController,
      iamDriver: selectedController.selectedDriver("iam"),
      computeDriver: selectedController.selectedDriver("compute"),
      configurationDriver: selectedController.selectedDriver("configuration"),
      secretDriver: selectedController.selectedDriver("secret"),
      resolveHarness: resolveApprovedHarness,
      auditSink: state.auditSink,
      auth: selectedAuth,
      publicOrigin,
      development: { enabled: false },
    });
    t.after(() => created.close());
    return created;
  };
  const reset = () => controller.applyIAMConfiguration();
  const withdraw = (independentCreate = false) =>
    controllerWith(policy(false, independentCreate)).applyIAMConfiguration();
  const namespace = async () => {
    const created = data<{ id: string }>(
      await inject("POST", "/namespaces", { name: `Durable ${randomUUID()}` }),
      201,
    );
    await controller.handleNamespaceLifecycle(fixture.principal.id, created.id, "ready");
    return created.id;
  };
  const effects = async (action: string, resourceId: string) => {
    const result = await pool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM occ.audit_events WHERE actor_id = $1 AND action = $2 AND resource_id = $3 AND outcome = 'success'",
      [actor.id, action, resourceId],
    );
    assert.ok(result.rows[0]);
    return result.rows[0].count;
  };
  const decision = (
    action: Permission["action"],
    kind: Permission["resourceKind"],
    id: string,
    namespaceId?: string,
  ) =>
    iam.authorize({
      principalId: actor.id,
      action,
      resource: { kind, id, ...(namespaceId === undefined ? {} : { namespaceId }) },
    });
  return {
    ...fixture,
    actor,
    account,
    credentials: { email, password },
    iam,
    request,
    controllerWith,
    createApp,
    reset,
    withdraw,
    namespace,
    effects,
    decision,
  };
}

test(
  "durable authority writes order configured-policy withdrawal at the real callers",
  { ...requiresPostgres, timeout: 120_000 },
  async (t) => {
    const f = await createFixture(t);
    const originalFetch = globalThis.fetch;
    let exchanges = 0;
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url !== tokenUrl) {
          return originalFetch(input, init);
        }
        assert.equal(request.method, "POST");
        const body = new URLSearchParams(await request.text());
        assert.equal(body.get("grant_type"), "authorization_code");
        assert.ok(body.get("code")?.startsWith("fixture-"));
        assert.ok(body.get("code_verifier"));
        exchanges++;
        return Response.json({
          access_token: "fixture-access-" + randomUUID(),
          refresh_token: "fixture-refresh-" + randomUUID(),
          token_type: "Bearer",
          expires_in: 3600,
          scope: "read",
        });
      },
    );

    async function connection(namespaceId: string) {
      const template = data<{ id: string; current: { version: string } }>(
        await f.inject("POST", "/connection-templates", {
          namespaceId,
          displayName: "Durable authority fixture",
          mode: "manual",
          issuer,
          authorizationUrl: issuer + "/authorize",
          tokenUrl,
          destinations: [{ host: "api.durable-authority.test", port: 443, path: "/data" }],
          scopes: ["read"],
        }),
        201,
      );
      data(
        await f.inject("POST", "/oauth-clients", {
          connectionTemplateId: template.id,
          connectionTemplateVersion: template.current.version,
          displayName: "Durable public fixture",
          clientId: "durable-" + randomUUID(),
          tokenEndpointAuthMethod: "none",
        }),
        201,
      );
      const started = data<{ authorizationUrl: string; expiresAt: string }>(
        await f.request("POST", `/namespaces/${namespaceId}/connections`, {
          connectionTemplateId: template.id,
        }),
        201,
      );
      const state = new URL(started.authorizationUrl).searchParams.get("state");
      assert.ok(state);
      assert.equal(Object.hasOwn(started, "credentialSourceId"), false);
      return {
        complete: () =>
          f.request(
            "GET",
            "/oauth/callback?" +
              new URLSearchParams({ state, iss: issuer, code: "fixture-" + randomUUID() }),
          ),
      };
    }

    async function connectionEffects(namespaceId: string, expected: 0 | 1) {
      const result = await f.pool.query<{ id: string; state: string }>(
        "SELECT id,state FROM occ.credential_sources WHERE namespace_id=$1 AND owner_capability='token_service' AND type='oauth2-refresh-token'",
        [namespaceId],
      );
      assert.equal(result.rowCount, expected);
      const policy = await f.state.loadNativeIAMState();
      const bindings = policy.bindings.filter(
        (binding) =>
          binding.namespaceId === namespaceId &&
          binding.subjectId === f.actor.id &&
          binding.resourceKind === "credential_source",
      );
      assert.equal(bindings.length, expected);
      if (expected === 1) {
        const source = result.rows[0]!;
        assert.equal(source.state, "ready");
        assert.equal(await f.effects("openclaw.namespaces.connections.complete", source.id), 1);
        assert.equal(
          (await f.decision("operate", "credential_source", source.id, namespaceId)).allowed,
          true,
        );
        const binding = bindings[0]!;
        assert.equal(binding.subjectId, f.actor.id);
        assert.equal(binding.resourceId, source.id);
        assert.deepEqual(policy.roles.find((role) => role.id === binding.roleId)?.permissions, [
          { resourceKind: "credential_source", action: "read" },
          { resourceKind: "credential_source", action: "operate" },
        ]);
        return source.id;
      }
    }

    await t.test("OAuth callback refuses a previously withdrawn Source-create grant", async () => {
      await f.reset();
      const namespaceId = await f.namespace();
      const attempt = await connection(namespaceId);
      await f.withdraw();
      const before = exchanges;
      const response = await attempt.complete();
      assert.equal(response.statusCode, 303);
      assert.match(String(response.headers.location), /connection=failed/);
      assert.equal(exchanges, before, "a denied callback does not redeem the provider code");
      await connectionEffects(namespaceId, 0);
    });

    await t.test(
      "OAuth Source owner can disconnect with its read/operate binding and no delete grant",
      async () => {
        await f.reset();
        const namespaceId = await f.namespace();
        const attempt = await connection(namespaceId);
        const response = await attempt.complete();
        assert.equal(response.statusCode, 303);
        assert.match(String(response.headers.location), /connection=connected/);
        const sourceId = await connectionEffects(namespaceId, 1);
        assert.ok(sourceId);
        assert.equal(
          (await f.decision("delete", "credential_source", sourceId, namespaceId)).allowed,
          false,
        );
        const sourcePath = `/namespaces/${namespaceId}/credential-sources/${sourceId}`;
        const ownerBinding = (await f.state.loadNativeIAMState()).bindings.find(
          (binding) => binding.id === `binding_${sourceId}_connection_owner`,
        );
        assert.ok(ownerBinding);
        const removedOwner = await f.inject(
          "DELETE",
          `/namespaces/${namespaceId}/iam/access-bindings/${ownerBinding.id}`,
        );
        assert.equal(removedOwner.statusCode, 204, removedOwner.body);
        assert.equal(
          (await f.decision("read", "credential_source", sourceId, namespaceId)).allowed,
          false,
        );
        assert.equal(
          (await f.decision("operate", "credential_source", sourceId, namespaceId)).allowed,
          false,
        );
        const denied = await f.request("DELETE", sourcePath);
        assert.equal(denied.statusCode, 403, denied.body);
        const retained = await f.pool.query(
          `SELECT s.state, c.credential_source_id FROM occ.credential_sources s
           JOIN occ.connection_token_custody c ON c.namespace_id=s.namespace_id AND c.credential_source_id=s.id
           WHERE s.namespace_id=$1 AND s.id=$2`,
          [namespaceId, sourceId],
        );
        assert.deepEqual(retained.rows, [{ state: "ready", credential_source_id: sourceId }]);
        const restored = await f.inject("POST", `/namespaces/${namespaceId}/iam/access-bindings`, {
          roleId: ownerBinding.roleId,
          subjectKind: ownerBinding.subjectKind,
          subjectId: ownerBinding.subjectId,
          resourceKind: "credential_source",
          resourceId: sourceId,
        });
        assert.equal(restored.statusCode, 201, restored.body);
        const disconnected = await f.request("DELETE", sourcePath);
        assert.equal(disconnected.statusCode, 204, disconnected.body);
        const deletionAudit = await f.pool.query(
          `SELECT details->'removedAccessBindings' AS removed FROM occ.audit_events
           WHERE action='openclaw.credential_sources.delete' AND resource_id=$1 AND outcome='success'
             AND details ? 'removedAccessBindings'`,
          [sourceId],
        );
        assert.equal(deletionAudit.rowCount, 1);
        assert.deepEqual(deletionAudit.rows[0].removed, [
          {
            id: restored.json().data.id,
            subjectKind: ownerBinding.subjectKind,
            subjectId: ownerBinding.subjectId,
            roleId: ownerBinding.roleId,
            resourceKind: "credential_source",
            resourceId: sourceId,
          },
        ]);
      },
    );

    function repositoryCompute() {
      const resources = {
        requests: { cpu: "100m", memory: "64Mi" },
        limits: { cpu: "250m", memory: "128Mi" },
      };
      const compute = new KubernetesComputeDriver(
        {
          gatewayRouting: {
            hostname: "agents.example.test",
            gatewayName: "gateways",
            gatewayNamespace: "controller",
            envoyNamespace: "envoy",
          },
          authentication: { mode: "inCluster" },
          images: { gateway: "gateway:local", agent: "agent:local", requireImmutableDigest: false },
          resources: {
            gateway: resources,
            agent: resources,
            namespace: { quota: { pods: "10" }, containerDefaults: resources },
          },
          runtime: {
            transportSecretPrefix: "transport",
            gatewayStorageClassName: "local-path",
            gatewayNodeSelector: { "oce-role": "control" },
          },
          network: {
            dns: { namespace: "kube-system", podLabels: { app: "dns" } },
            gatewayPort: 8080,
            gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
            repositoryCredentials: {
              namespace: "controller",
              podLabels: { app: "worker" },
              port: 8443,
            },
          },
          servicePrincipalCredentials: { mode: "disabled" },
        },
        { id: "durable-repository-compute" },
      );
      // The existing admission fixture supplies this external prerequisite without a
      // cluster. Kubernetes still owns and executes repository and Harness validation.
      t.mock.method(compute, "getAgentRuntimeCredentialStatus", async () => ({
        transportConfigured: true,
      }));
      return compute;
    }

    async function repositoryAgent(namespaceId: string) {
      const repo = new GitHubRepositoryPolicy(
        { driverId: "durable-repo", backendId: "durable-github" },
        {
          version: 1,
          backendId: "durable-github",
          providerInstanceId: "fixture-provider",
          appId: "41",
          githubInstallationId: "42",
          maximumDurationSeconds: 3600,
          allowStandingApprovals: true,
          repositories: [
            {
              repositoryRef: "fixture-repository",
              repositoryId: "43",
              repository: "fixture-owner/fixture-repository",
              namespaces: [{ namespaceId, profiles: ["git-read"], allowStandingApproval: true }],
            },
          ],
        },
        { sessionDurationSeconds: 600 },
      );
      const controller = f.controllerWith(
        policy(true),
        {
          backends: [
            {
              id: "durable-github",
              type: "github",
              configuration: { registryPath: "/fixture/durable-repositories.json" },
              drivers: { repo: repo.id },
            },
          ],
        },
        { policyMode: "built-in", policy: repo, backendId: "durable-github" },
      );
      const compute = repositoryCompute();
      controller.registerDriver(compute);
      controller.selectDriver("compute", compute.id);
      const app = f.createApp(controller);
      const native = createHarnessConfiguration("openclaw", "gpt-4.1");
      const gateway: Partial<typeof native.gateway> = { ...native.gateway };
      delete gateway.auth;
      const configuration = data<{ id: string }>(
        await f.inject(
          "POST",
          `/namespaces/${namespaceId}/configurations`,
          { kind: "agent", values: { ...native, gateway } },
          app,
        ),
        201,
      );
      const secret = data<{ ref: { kind: "secret"; namespaceId: string; id: string } }>(
        await f.inject(
          "POST",
          `/namespaces/${namespaceId}/secrets`,
          {
            name: "Durable repository model " + randomUUID(),
            value: "fixture-model-" + randomUUID(),
          },
          app,
        ),
        201,
      );
      const agent = data<Agent>(
        await f.inject(
          "POST",
          `/namespaces/${namespaceId}/agents`,
          {
            name: "Durable repository approval",
            configurationId: configuration.id,
            harnessAuth: { method: "api_key", source: secret.ref },
            repositoryBindings: [{ repositoryRef: "fixture-repository", profile: "git-read" }],
          },
          app,
        ),
        201,
      );
      const [scope] = await controller.listAgentStandingApprovalScopes(
        f.actor.id,
        namespaceId,
        agent.id,
      );
      assert.ok(scope);
      const approvalId = "approval-" + randomUUID();
      const body = {
        configurationId: configuration.id,
        repositoryStandingApproval: {
          approved: true,
          approvalId,
          repositoryRef: scope.repositoryRef,
          duration: "until-removed",
          expectedScopeFingerprint: scope.scopeFingerprint,
        },
      };
      const approve = (input = body) =>
        f.request("PATCH", `/namespaces/${namespaceId}/agents/${agent.id}`, input, app);
      const approvals = () =>
        f.state.read((unit) =>
          unit.repositorySessions.listStandingApprovals(namespaceId, agent.id),
        );
      return { controller, app, agent, scope, approvalId, body, approve, approvals };
    }

    await t.test("Agent PATCH holds standing approval authority through COMMIT", async () => {
      await f.reset();
      const namespaceId = await f.namespace();
      const candidate = await repositoryAgent(namespaceId);
      assert.equal(
        (await f.decision("administer", "agent", candidate.agent.id, namespaceId)).allowed,
        true,
      );
      data(await authorityFirst(f.pool, namespaceId, candidate.approve, () => f.withdraw()), 200);
      const approvals = await candidate.approvals();
      assert.equal(approvals.length, 1);
      assert.equal(approvals[0]?.id, candidate.approvalId);
      assert.equal(approvals[0]?.generation, 1);
      assert.equal(approvals[0]?.scopeFingerprint, candidate.scope.scopeFingerprint);
      assert.equal(approvals[0]?.approvedBy, f.actor.id);
      assert.equal(await f.effects("openclaw.agents.update", candidate.agent.id), 1);
      assert.equal(
        (await f.decision("administer", "agent", candidate.agent.id, namespaceId)).allowed,
        false,
      );
    });

    await t.test("Agent PATCH refuses a preceding administrator withdrawal", async () => {
      await f.reset();
      const namespaceId = await f.namespace();
      const candidate = await repositoryAgent(namespaceId);
      assert.equal(
        (await f.decision("administer", "agent", candidate.agent.id, namespaceId)).allowed,
        true,
      );
      const response = await withdrawalFirst(f.pool, candidate.approve, () => f.withdraw());
      assert.equal(response.statusCode, 403, response.body);
      assert.deepEqual(await candidate.approvals(), []);
      assert.equal(await f.effects("openclaw.agents.update", candidate.agent.id), 0);
      assert.equal(
        (await f.decision("administer", "agent", candidate.agent.id, namespaceId)).allowed,
        false,
      );
      const ordinary = await f.request(
        "PATCH",
        `/namespaces/${namespaceId}/agents/${candidate.agent.id}`,
        {
          configurationId: candidate.agent.configurationId,
        },
        candidate.app,
      );
      data(ordinary, 200);
    });

    await t.test(
      "unchanged Agent authority creates one approval and refuses a mismatched scope",
      async () => {
        await f.reset();
        const namespaceId = await f.namespace();
        const candidate = await repositoryAgent(namespaceId);
        const mismatch = await candidate.approve({
          ...candidate.body,
          repositoryStandingApproval: {
            ...candidate.body.repositoryStandingApproval,
            expectedScopeFingerprint: "0".repeat(64),
          },
        });
        assert.equal(mismatch.statusCode, 409, mismatch.body);
        assert.deepEqual(await candidate.approvals(), []);
        assert.equal(await f.effects("openclaw.agents.update", candidate.agent.id), 0);
        data(await candidate.approve(), 200);
        const [approval, extra] = await candidate.approvals();
        assert.ok(approval);
        assert.equal(extra, undefined);
        assert.equal(approval.id, candidate.approvalId);
        assert.equal(approval.generation, 1);
        assert.equal(approval.scopeFingerprint, candidate.scope.scopeFingerprint);
        const deployed = data<{ id: string }>(
          await f.request(
            "POST",
            `/namespaces/${namespaceId}/agents/${candidate.agent.id}/deploy`,
            undefined,
            candidate.app,
          ),
          202,
        );
        const revision = await f.state.read((unit) =>
          unit.revisions.findRevision(namespaceId, candidate.agent.id, deployed.id),
        );
        assert.ok(revision?.repositoryCredentials);
        assert.equal(revision.repositoryCredentials.standingApprovalId, approval.id);
        assert.equal(
          revision.repositoryCredentials.standingApprovalGeneration,
          approval.generation,
        );
        assert.equal(
          revision.repositoryCredentials.standingApprovalScopeFingerprint,
          approval.scopeFingerprint,
        );
      },
    );

    function startup() {
      const defaults: readonly PresetDraftDefinition[] = [
        {
          name: "Durable default " + randomUUID(),
          template: {},
        },
      ];
      const controller = f.controllerWith(policy(true), { defaultPresets: defaults });
      return {
        defaults,
        run: () => initializeInstallationPresets(controller, f.iam, [f.actor], defaults),
      };
    }

    async function presetEffects(namespaceId: string, name: string, expected: 0 | 1) {
      const presets = await f.state.read((unit) => unit.presets.listPresets(namespaceId));
      const selected = presets.filter((preset) => preset.name === name);
      assert.equal(selected.length, expected);
      if (expected === 0) {
        const result = await f.pool.query<{ count: number }>(
          "SELECT count(*)::integer AS count FROM occ.audit_events WHERE actor_id = $1 AND namespace_id = $2 AND action = 'openclaw.presets.create' AND outcome = 'success' AND details->>'source' = 'installation-defaults'",
          [f.actor.id, namespaceId],
        );
        assert.equal(result.rows[0]?.count, 0);
        return;
      }
      const preset = selected[0]!;
      const bindings = (await f.state.loadNativeIAMState()).bindings.filter(
        (binding) => binding.id === `binding_owner_${preset.id}`,
      );
      assert.equal(bindings.length, 1);
      assert.equal(bindings[0]?.subjectId, f.actor.id);
      assert.equal(await f.effects("openclaw.presets.create", preset.id), 1);
      assert.equal((await f.decision("update", "preset", preset.id, namespaceId)).allowed, true);
    }

    await t.test("startup helper holds default-Preset authority through COMMIT", async () => {
      await f.reset();
      const namespaceId = await f.namespace();
      const candidate = startup();
      assert.equal((await f.decision("create", "preset", namespaceId, namespaceId)).allowed, true);
      await authorityFirst(f.pool, namespaceId, candidate.run, () => f.withdraw());
      await presetEffects(namespaceId, candidate.defaults[0]!.name, 1);
      assert.equal((await f.decision("create", "preset", namespaceId, namespaceId)).allowed, false);
    });

    await t.test("startup helper refuses a preceding create withdrawal", async () => {
      await f.reset();
      const namespaceId = await f.namespace();
      const candidate = startup();
      assert.equal((await f.decision("create", "preset", namespaceId, namespaceId)).allowed, true);
      await assert.rejects(
        withdrawalFirst(f.pool, candidate.run, () => f.withdraw()),
        /requires an Installation administrator who can create Presets/,
      );
      await presetEffects(namespaceId, candidate.defaults[0]!.name, 0);
      assert.equal((await f.decision("create", "preset", namespaceId, namespaceId)).allowed, false);
    });

    await t.test("startup helper retains unchanged and independent create grants", async () => {
      await f.reset();
      const namespaceId = await f.namespace();
      const unchanged = startup();
      await unchanged.run();
      await presetEffects(namespaceId, unchanged.defaults[0]!.name, 1);
      await f.withdraw(true);
      const independent = startup();
      await independent.run();
      await presetEffects(namespaceId, independent.defaults[0]!.name, 1);
    });
    await t.test("a disabled account cannot save a new standing approval", async () => {
      await f.reset();
      const namespaceId = await f.namespace();
      const candidate = await repositoryAgent(namespaceId);
      const bootstrapPrincipal = f.principal;
      assert.ok(bootstrapPrincipal.kind === "principal");
      const login = humanLoginConfiguration({
        OCC_AUTH_OIDC_ISSUER: fixtureOidcIssuer.issuer,
        OCC_AUTH_OIDC_AUTHORIZATION_URL: fixtureOidcIssuer.authorizationUrl,
        OCC_AUTH_OIDC_TOKEN_URL: fixtureOidcIssuer.tokenUrl,
        OCC_AUTH_OIDC_JWKS_URL: fixtureOidcIssuer.jwksUrl,
        OCC_AUTH_OIDC_CLIENT_ID: "durable-authority-guarded",
        OCC_AUTH_OIDC_CLIENT_SECRET: "fixture-" + randomUUID(),
        OCC_AUTH_RECOVERY_USER_ID: bootstrapPrincipal.subject,
      });
      const auth = await createPostgresControllerAuth({
        mode: "development",
        installationId: f.controller.installation.id,
        baseURL: publicOrigin,
        agentDomain: "agents.oce.localhost",
        secret: "durable-authority-fixture-session-secret",
        pool: f.pool,
        state: f.state,
        iamDriver: f.iam,
        ...login,
      });
      const app = f.createApp(candidate.controller, auth);
      const actorSession = await signInToControllerApp(app, f.credentials);
      const adminSession = await signInToControllerApp(app, f.adminAccount);
      const actorHeaders = {
        host: new URL(actorSession.origin).host,
        ...authenticatedHeaders(actorSession),
      };
      const adminHeaders = {
        host: new URL(adminSession.origin).host,
        ...authenticatedHeaders(adminSession),
      };
      const url = `/namespaces/${namespaceId}/agents/${candidate.agent.id}`;
      data(
        await app.inject({
          method: "PATCH",
          url,
          headers: actorHeaders,
          payload: { configurationId: candidate.agent.configurationId },
        }),
        200,
      );
      const before = await f.effects("openclaw.agents.update", candidate.agent.id);
      const disabled = await changeAccount(app, adminHeaders, f.actor.subject, "disable");
      data(disabled, 200);
      const response = await app.inject({
        method: "PATCH",
        url,
        headers: actorHeaders,
        payload: candidate.body,
      });
      assert.ok(response.statusCode === 401 || response.statusCode === 403, response.body);
      assert.deepEqual(await candidate.approvals(), []);
      assert.equal(await f.effects("openclaw.agents.update", candidate.agent.id), before);
    });
  },
);
