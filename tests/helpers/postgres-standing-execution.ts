import type { InstallationStartupConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { GitHubRepositoryRegistry } from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import type { AgentRevision } from "../../packages/contracts/src/index.ts";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import type { Pool } from "pg";
import { repositoryApprovalFingerprint } from "../../packages/occ/src/index.ts";
import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import { ensurePostgresAgentBootstrap } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl } from "../helpers/postgres-database.mjs";

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
    credentialGateway?: import("../../packages/contracts/src/index.ts").CredentialGatewayDriver;
    modelConfig?: { base_url: string };
    activePredecessor?: boolean;
    requestedBinding?: {
      repositoryRef: string;
      profile: "github-installation";
    };
  }>,
  driverSelections: Partial<InstallationStartupConfiguration["drivers"]> = {},
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
      id: registry.backendId,
      client: external?.protectedDriver
        ? undefined
        : new UnixRepositoryCredentialControlClient({
            controlSocket: external?.controlSocket ?? "/unused-execution-contract/control.sock",
          }),
      drivers: { repo: registry.backendId },
    },
    registry,
    { sessionDurationSeconds: 120 },
  );
  const owner = await f.agent("execution-fence", {
    executionMode: "dedicated",
    auth: external && !external.protectedDriver ? "secret" : "credential_source",
    modelConfig: external?.modelConfig,
  });
  // Start a real predecessor before admitting Git on its successor. The candidate must
  // remain unable to receive repository material while this pointer is still active.
  const predecessor = external?.activePredecessor ? await f.revision(owner, 1) : undefined;
  if (predecessor) {
    try {
      await f.start(f.compute, {
        transformDrivers: (d: { installation: { drivers: object } }) => ({
          ...d,
          credentialGatewayDriver: external!.credentialGateway,
          protectedDriver: external!.protectedDriver,
          sandboxDriver: external!.protectedDriver?.require("sandbox"),
          proxyDriver: external!.protectedDriver?.require("credential_proxy"),
          installation: {
            ...d.installation,
            drivers: {
              ...d.installation.drivers,
              credential_gateway: { id: external!.credentialGateway!.id },
            },
          },
        }),
      });
      await f.work(predecessor, "succeeded");
    } finally {
      await f.stop();
    }
  }
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
  await f.observerPool.query("UPDATE occ.agents SET repository_bindings=$1 WHERE id=$2", [
    JSON.stringify(bindings),
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
  if (external?.protectedDriver && external.credentialGateway) {
    const gateway = external.credentialGateway;
    f.controller.installDriver(external.protectedDriver, ["sandbox", "credential_proxy"]);
    f.controller.registerDriver(gateway);
    f.controller.selectDriver("credential_gateway", gateway.id);
  }
  const revision = (await f.revision(owner, predecessor ? 2 : 1, {
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
    predecessor,
    revisionOptions,
    credentials,
    driver,
  };
}

export async function standingExecutionPlatform(
  t: TestContext,
  testUrl: string,
  driverSelections: Partial<InstallationStartupConfiguration["drivers"]> = {},
) {
  await ensurePostgresAgentBootstrap(t, {
    label: "standing-execution",
    authSecret: "standing-execution-local-test-secret-32",
  });
  const database = {
    url: databaseUrl!,
    pools: new Set<Pool>(),
    workers: new Set(),
  };
  t.after(async () => {
    for (const pool of database.pools) {
      if (!("ending" in pool && pool.ending)) {
        await pool.end();
      }
    }
  });
  const setupOptions = { database, leaseDurationMs: 30_000, driverSelections };
  return createWorkerRevisionFixtures(testUrl).setup(t, setupOptions);
}
