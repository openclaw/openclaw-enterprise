import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { Pool } from "pg";
import type { AgentRevision } from "../../packages/contracts/src/index.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { OpenShellCredentialProxyDriver } from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import { InstalledDriver } from "../../packages/occ/src/index.ts";
import { createOpenShellCapabilities } from "../../apps/controller/src/drivers/egress-proxy/openshell-registration.ts";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { createBackendWorkerDrivers } from "./postgres-backend-state.mjs";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { createTestKubernetesComputeDriver } from "./kubernetes-compute.mjs";
import { composePostgresDevelopment } from "./password-hasher.mjs";
import { authenticatedHeaders, cookieHeaderFromSetCookie } from "./auth-session.mjs";
import { databaseUrl } from "./postgres-database.mjs";

/** API composition has its own Git owner and database pool. Only Kubernetes discovery is
 * controlled; the disposition travels through authenticated Fastify, OCC, Compute and Sandbox. */
export async function repositoryRestartInventory(
  t: TestContext,
  revision: AgentRevision,
  input: Parameters<typeof createOpenShellCapabilities>[0],
) {
  const capabilities = createOpenShellCapabilities(input);
  t.after(() => capabilities.close());
  const owner = new InstalledDriver(
    {
      ...input.sandbox,
      configuration: input.proxy!.configuration,
    },
    { capabilities: { sandbox: capabilities.sandbox, credential_proxy: capabilities.proxy! } },
  );
  const compute = createTestKubernetesComputeDriver(revision.compute.id, {
    repositoryCredentials: true,
    protectedDriver: owner,
  });
  const metadata = {
    name: kubernetesNamespaceName(revision.namespaceId),
    ...compute["ownershipMetadata"]({ namespaceId: revision.namespaceId }),
  };
  t.mock.method(compute, "preflight", async () => ({ warnings: [] }));
  t.mock.method(compute, "clients" as never, async () => ({
    core: {
      listNamespace: async () => ({ items: [{ metadata }] }),
      readNamespace: async () => ({
        apiVersion: "v1",
        kind: "Namespace",
        metadata,
        status: { phase: "Active" },
      }),
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

  const installation = {
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
  // Register the same selected owner in Compute and API composition. No exchange or
  // repository sender is configured on this read-only API instance.
  const app = await composePostgresDevelopment(
    {
      mode: "development",
      host: "127.0.0.1",
      databaseUrl: databaseUrl!,
      authSecret: "standing-execution-local-test-secret-32",
      authBaseURL: "http://127.0.0.1",
    },
    {
      ...drivers,
      installation,
      protectedDriver: owner,
      sandboxDriver: capabilities.sandbox,
      repositoryTransport: capabilities.repositoryTransport,
    },
  );
  t.after(() => app.close());
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    payload: JSON.stringify({
      email: "postgres-admin@openclaw.local",
      password: "postgres-development-password",
    }),
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookies = login.headers["set-cookie"];
  const headers = authenticatedHeaders({
    origin: "http://127.0.0.1",
    cookie: cookieHeaderFromSetCookie(cookies),
  });
  return async () => {
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
    assert.equal(agent.activeRevisionId, revision.id);
    return agent.repositoryWorkerRestart;
  };
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
