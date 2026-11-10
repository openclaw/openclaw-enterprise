import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { Pool } from "pg";
import type { AgentRevision } from "../../packages/contracts/src/index.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { OpenShellCredentialProxyDriver } from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import { InstalledDriver, PostgresHumanAuthentication } from "../../packages/occ/src/index.ts";
import { createOpenShellCapabilities } from "../../apps/controller/src/drivers/egress-proxy/openshell-registration.ts";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { createBackendWorkerDrivers } from "./postgres-backend-state.mjs";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { createTestKubernetesComputeDriver } from "./kubernetes-compute.mjs";
import { composePostgresDevelopment, createPostgresControllerAuth } from "./password-hasher.mjs";
import { validateAuthAccountPrincipalSeed } from "../../packages/iam/src/index.ts";
import { betterAuthIssuer } from "../../apps/controller/src/auth/index.ts";
import type { standingExecutionPlatform } from "./postgres-standing-execution.ts";
import { authenticatedHeaders, cookieHeaderFromSetCookie } from "./auth-session.mjs";

/** API composition has its own Git owner and database pool. Only Kubernetes discovery is
 * controlled; the disposition travels through authenticated Fastify, OCC, Compute and Sandbox. */
export async function repositoryRestartInventory(
  t: TestContext,
  revision: AgentRevision,
  input: Parameters<typeof createOpenShellCapabilities>[0] | undefined,
  fixture: Pick<
    Awaited<ReturnType<typeof standingExecutionPlatform>>,
    "database" | "observerPool" | "state" | "installation" | "actor" | "controller"
  >,
) {
  const capabilities = input === undefined ? undefined : createOpenShellCapabilities(input);
  t.after(() => capabilities?.close());
  const owner =
    input !== undefined && capabilities !== undefined
      ? new InstalledDriver(
          { ...input.sandbox, configuration: input.proxy!.configuration },
          {
            capabilities: { sandbox: capabilities.sandbox, credential_proxy: capabilities.proxy! },
          },
        )
      : undefined;
  const compute = createTestKubernetesComputeDriver(revision.compute.id, {
    ...(owner === undefined ? {} : { repositoryCredentials: true, protectedDriver: owner }),
  });
  const metadata = {
    name: kubernetesNamespaceName(revision.namespaceId),
    ...compute["ownershipMetadata"]({ namespaceId: revision.namespaceId }),
  };
  const namespace = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata,
    status: { phase: "Active" },
  };
  t.mock.method(compute, "preflight", async () => ({ warnings: [] }));
  t.mock.method(compute, "clients" as never, async () => ({
    core: {
      listNamespace: async () => ({ items: [{ metadata }] }),
      readNamespace: async () => namespace,
    },
  }));
  const drivers = createBackendWorkerDrivers(compute, []);
  // Normalize the same startup document as the real API. The raw fixture contains
  // selections only; composition also needs resolved definitions and logging defaults.
  const configured = await loadInstallationConfiguration({
    mode: "development",
    environment: {},
    startupConfiguration: {
      configuration: drivers.installation,
      logging: { level: "info" },
    },
  });
  assert.ok(configured);

  const installation =
    input === undefined
      ? configured.installation
      : {
          ...configured.installation,
          drivers: {
            ...configured.installation.drivers,
            sandbox: {
              ...input.sandbox,
              configuration: input.proxy!.configuration,
              definition: {
                configurationSchema: OpenShellCredentialProxyDriver.configurationSchema,
                validateConfiguration: OpenShellCredentialProxyDriver.validateConfiguration,
                configurationContributions: OpenShellSandboxDriver.configurationContributions,
              },
            },
          },
        };
  // The worker fixture owns a per-test database and an IAM-only actor. Provision
  // an actual password account there before exercising the authenticated API.
  const authSecret = "standing-execution-local-test-secret-32";
  const origin = "https://console.oce.localhost";
  const credentials = {
    email: "postgres-admin@openclaw.local",
    password: "postgres-development-password",
  };
  const auth = await createPostgresControllerAuth({
    mode: "development",
    installationId: fixture.installation.id,
    baseURL: origin,
    agentDomain: "agents.oce.localhost",
    secret: authSecret,
    pool: fixture.observerPool,
  });
  const iam = await fixture.state.loadNativeIAMState(fixture.installation.id);
  const roleId = iam.bindings.find((binding) => binding.subjectId === fixture.actor.id)?.roleId;
  assert.ok(roleId);
  const prepared = await auth.prepareAccount(credentials);
  const seed = auth.principalSeed(prepared, { roleId });
  validateAuthAccountPrincipalSeed(seed, iam, fixture.installation.id);
  await new PostgresHumanAuthentication(
    fixture.state,
    fixture.installation.id,
    betterAuthIssuer(fixture.installation.id),
  ).provisionPasswordAccount(prepared, seed);
  // Additional accounts have Installation-only grants. Bind the exact Namespace
  // and Agent needed by this inventory read, including its retained revisions.
  const inventoryRole = await fixture.controller.createIAMRole(fixture.actor.id, {
    namespaceId: revision.namespaceId,
    permissions: [
      { action: "read", resourceKind: "namespace" },
      { action: "read", resourceKind: "agent" },
      { action: "deploy", resourceKind: "agent" },
      { action: "read", resourceKind: "agent_revision" },
    ],
  });
  for (const [resourceKind, resourceId] of [
    ["namespace", revision.namespaceId],
    ["agent", revision.agentId],
  ] as const) {
    await fixture.controller.createIAMAccessBinding(fixture.actor.id, {
      namespaceId: revision.namespaceId,
      subjectKind: "identity",
      subjectId: seed.principal.id,
      roleId: inventoryRole.id,
      resourceKind,
      resourceId,
    });
  }

  // Register the same selected owner in Compute and API composition. No exchange or
  // repository sender is configured on this read-only API instance.
  const app = await composePostgresDevelopment(
    {
      mode: "development",
      host: "127.0.0.1",
      databaseUrl: fixture.database.url,
      authSecret,
      authBaseURL: origin,
      nativeAdmin: { enabled: false, domain: "agents.oce.localhost" },
    },
    {
      ...drivers,
      installation,
      ...(owner === undefined || capabilities === undefined
        ? {}
        : {
            protectedDriver: owner,
            sandboxDriver: capabilities.sandbox,
            repositoryTransport: capabilities.repositoryTransport,
          }),
    },
  );
  t.after(() => app.close());
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { host: "console.oce.localhost", "content-type": "application/json" },
    payload: JSON.stringify(credentials),
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookies = login.headers["set-cookie"];
  const headers = authenticatedHeaders(
    { origin, cookie: cookieHeaderFromSetCookie(cookies) },
    { host: "console.oce.localhost" },
  );
  const read = async (activeRevisionId = revision.id) => {
    const response = await app.inject({
      method: "GET",
      url: "/installation/deployment-inventory",
      headers,
    });
    assert.equal(response.statusCode, 200, response.body);
    const namespace = response
      .json()
      .data.namespaces.find((entry: { id: string }) => entry.id === revision.namespaceId);
    const agent = namespace.agents.find((entry: { id: string }) => entry.id === revision.agentId);
    assert.equal(agent.activeRevisionId, activeRevisionId);
    return agent.repositoryWorkerRestart;
  };
  return { read, namespace };
}

/** Hash complete owner rows so failures reveal no stored credential material. */
export async function repositoryRestartState(pool: Pool, revisionId: string) {
  const result: Record<string, unknown> = {};
  for (const table of [
    "credential_deliveries",
    "repository_standing_executions",
    "repository_session_attempts",
    "controller_work",
    "egress_installations",
  ]) {
    const { rows } = await pool.query(
      `SELECT md5(row_to_json(r)::text) AS digest FROM occ.${table} r WHERE revision_id=$1 ORDER BY digest`,
      [revisionId],
    );
    result[table] = rows;
  }
  const { rows } = await pool.query(
    `SELECT md5(row_to_json(a)::text) AS digest
     FROM occ.prepared_github_attempts a
     JOIN occ.prepared_github_families f USING (source_id)
     WHERE f.source #>> '{session,revisionId}'=$1 ORDER BY digest`,
    [revisionId],
  );
  result.preparedGitHubAttempts = rows;
  return result;
}
