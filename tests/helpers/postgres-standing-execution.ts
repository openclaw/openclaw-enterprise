import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { GitHubRepositoryRegistry } from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import type { AgentRevision } from "../../packages/contracts/src/index.ts";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import type { Pool } from "pg";
import { repositoryApprovalFingerprint } from "../../packages/occ/src/index.ts";
import { GitHubRepoDriver } from "../../apps/controller/src/drivers/repo/github/driver.ts";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import { ensurePostgresAgentBootstrap } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl } from "../helpers/postgres-database.mjs";

export async function standingExecutionFixture(
  t: TestContext,
  testUrl: string,
  setupRepository?: (
    pool: Pool,
    namespaceId: string,
  ) => Promise<{ registry: GitHubRepositoryRegistry; controlSocket: string; backendId: string }>,
) {
  await ensurePostgresAgentBootstrap(t, {
    label: "standing-execution",
    authSecret: "standing-execution-local-test-secret-32",
  });
  const database = { url: databaseUrl!, pools: new Set<Pool>(), workers: new Set() };
  t.after(async () => {
    for (const pool of database.pools) {
      if (!("ending" in pool && pool.ending)) {
        await pool.end();
      }
    }
  });
  const setupOptions = { database, leaseDurationMs: 30_000 };
  const f = await createWorkerRevisionFixtures(testUrl).setup(t, setupOptions);
  const external = await setupRepository?.(f.observerPool, f.namespace.id);
  const registry =
    external?.registry ??
    ({
      version: 1,
      backendId: "execution-proof",
      providerInstanceId: "local-provider",
      appId: "123",
      githubInstallationId: "456",
      maximumDurationSeconds: 120,
      allowStandingApprovals: true,
      repositories: [
        {
          repositoryRef: "source",
          repositoryId: "789",
          repository: "example/source",
          namespaces: [
            {
              namespaceId: f.namespace.id,
              profiles: ["git-write"],
              allowStandingApproval: true,
              transport: "git-only",
              pushRefAllowlist: ["refs/heads/review"],
            },
          ],
        },
      ],
    } as const);
  const driver = new GitHubRepoDriver(
    {
      id: registry.backendId,
      client: new UnixRepositoryCredentialControlClient({
        controlSocket: external?.controlSocket ?? "/unused-execution-contract/control.sock",
      }),
      drivers: { repo: registry.backendId },
    },
    registry,
    { sessionDurationSeconds: 120 },
  );
  const owner = await f.agent("execution-fence", {
    executionMode: "dedicated",
    auth: external ? "secret" : "credential_source",
  });
  const [selected] = driver.resolve({
    namespaceId: f.namespace.id,
    bindings: [{ repositoryRef: "source", profile: "git-write" }],
  }).bindings;
  const binding = selected!;
  await f.observerPool.query("UPDATE occ.agents SET repository_bindings=$1 WHERE id=$2", [
    JSON.stringify([{ repositoryRef: "source", profile: "git-write" }]),
    owner.id,
  ]);
  const scope = driver.standingApprovalScope({ namespaceId: f.namespace.id, binding })!;
  const fingerprint = repositoryApprovalFingerprint({
    namespaceId: f.namespace.id,
    agentId: owner.id,
    binding,
    scope,
  });
  const approval = await f.state.transact((u) =>
    u.repositorySessions.approveStanding({
      id: randomUUID(),
      namespaceId: f.namespace.id,
      agentId: owner.id,
      binding,
      scope,
      scopeFingerprint: fingerprint,
      approvedBy: f.actor.id,
      createdAt: new Date().toISOString(),
    }),
  );
  const credentials = {
    driver: { id: driver.id, implementation: driver.implementation },
    bindings: [binding],
    deadlineWallMs: Date.now() + 120_000,
    standingApprovalId: approval.id,
    standingApprovalGeneration: approval.generation,
    standingApprovalScopeFingerprint: fingerprint,
  };
  const revisionOptions = { actorId: f.actor.id, repositoryCredentials: credentials };
  const revision = (await f.revision(owner, 1, revisionOptions)) as AgentRevision;
  const key = { namespaceId: f.namespace.id, agentId: owner.id, revisionId: revision.id };
  if (!external) {
    await f.state.transact((u) =>
      u.agents.compareAndSetActiveRevision(key.namespaceId, key.agentId, undefined, key.revisionId),
    );
  }
  return {
    f,
    key,
    approval,
    registry,
    binding,
    owner,
    revision,
    revisionOptions,
    credentials,
    driver,
  };
}
