import type { InstallationStartupConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { GitHubRepositoryRegistry } from "../../apps/controller/src/drivers/repo/github/access/registry.ts";
import type { AgentRevision } from "../../packages/contracts/src/index.ts";
import type { Pool } from "pg";
import { repositoryApprovalFingerprint } from "../../packages/occ/src/index.ts";
import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";

export async function standingExecutionFixture(
  t: TestContext,
  testUrl: string,
  setupRepository?: (
    pool: Pool,
    namespaceId: string,
  ) => Promise<{
    registry: GitHubRepositoryRegistry;
    controlSocket?: string;
    backendId: string;
    protectedDriver?: import("../../packages/occ/src/index.ts").InstalledDriver;
    requestedBinding?: {
      repositoryRef: string;
      profile: "github-installation";
    };
  }>,
  driverSelections: Partial<InstallationStartupConfiguration["drivers"]> = {},
  firstAdmissionDurationMs = 120_000,
) {
  const f = await standingExecutionPlatform(t, testUrl, driverSelections);
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
  const driver = new GitHubRepositoryPolicy(
    {
      driverId: external?.backendId ?? "execution-proof",
      backendId: external?.backendId ?? "execution-proof",
    },
    registry,
    { sessionDurationSeconds: 120 },
  );
  const owner = await f.agent("execution-fence", {
    executionMode: "dedicated",
    auth: external?.protectedDriver ? "runtime" : "secret",
  });
  const bindings = [
    external?.requestedBinding ?? {
      repositoryRef: "source",
      profile: "git-write",
    },
  ];
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
    deadlineWallMs: Date.now() + firstAdmissionDurationMs,
    standingApprovalId: approval.id,
    standingApprovalGeneration: approval.generation,
    standingApprovalScopeFingerprint: fingerprint,
  };
  const revisionOptions = {
    actorId: f.actor.id,
    repositoryCredentials: credentials,
  };
  if (external?.protectedDriver) {
    f.controller.installDriver(external.protectedDriver, ["sandbox", "credential_proxy"]);
  }
  const revision = (await f.revision(owner, 1, {
    ...revisionOptions,
    ...(external?.protectedDriver && {
      protectedRepositoryDriver: external.protectedDriver,
    }),
  })) as AgentRevision;
  const key = {
    namespaceId: f.namespace.id,
    agentId: owner.id,
    revisionId: revision.id,
  };
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

export async function standingExecutionPlatform(
  t: TestContext,
  testUrl: string,
  driverSelections: Partial<InstallationStartupConfiguration["drivers"]> = {},
  backends: import("../../packages/contracts/src/index.ts").BackendDefinition[] = [],
) {
  // Each fixture owns its database: another case's issuer may use the same Driver
  // identity but a different custody key, so it cannot inherit encrypted retirements.
  return createWorkerRevisionFixtures(testUrl).setup(t, { driverSelections, backends });
}
