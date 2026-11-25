import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { GitHubRepositoryRegistry } from "../../apps/controller/src/drivers/repo/github/access/registry.ts";
import type { AgentRevision } from "../../packages/contracts/src/index.ts";
import { repositoryApprovalFingerprint } from "../../packages/occ/src/index.ts";
import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";

export async function standingExecutionFixture(t: TestContext, testUrl: string) {
  // The fixture owns its database and prepared repository custody.
  const f = await createWorkerRevisionFixtures(testUrl).setup(t);
  const registry = {
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
  } as const satisfies GitHubRepositoryRegistry;
  const driver = new GitHubRepositoryPolicy(
    {
      driverId: "execution-proof",
      backendId: "execution-proof",
    },
    registry,
    { sessionDurationSeconds: 120 },
  );
  const owner = await f.agent("execution-fence", {
    executionMode: "dedicated",
    auth: "secret",
  });
  const bindings = [
    {
      repositoryRef: "source",
      profile: "git-write",
    },
  ] as const;
  const [selected] = driver.resolve({
    namespaceId: f.namespace.id,
    bindings,
  }).bindings;
  const binding = selected!;
  await f.observerPool.query("UPDATE occ.agents SET repository_access=$1 WHERE id=$2", [
    JSON.stringify({ defaultProfile: "git-write", repositories: bindings }),
    owner.id,
  ]);
  const scope = driver.standingApprovalScope({
    namespaceId: f.namespace.id,
    binding,
  })!;
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
  const revisionOptions = {
    actorId: f.actor.id,
    repositoryCredentials: credentials,
  };
  const revision = (await f.revision(owner, 1, revisionOptions)) as AgentRevision;
  const key = {
    namespaceId: f.namespace.id,
    agentId: owner.id,
    revisionId: revision.id,
  };
  await f.state.transact((u) =>
    u.agents.compareAndSetActiveRevision(key.namespaceId, key.agentId, undefined, key.revisionId),
  );
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
