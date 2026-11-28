import { isDeepStrictEqual } from "node:util";
import type {
  AgentRevision,
  ComputeDriver,
  InstallationDeploymentInventory,
  RepositoryWorkerRestartDisposition,
} from "@openclaw-enterprise/contracts";
import { isNonEmptyString } from "@openclaw-enterprise/utils";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import { unchangedDriver, type RegisteredDriver } from "./driver-registry.ts";
import { DependencyUnavailableError } from "./errors.ts";

interface DeploymentInventoryDependencies {
  readonly installationId: string;
  readonly authorize: ControllerAuthority["authorize"];
  readonly read: ControllerTransactions["read"];
  readonly driverSelection: (capability: "compute" | "sandbox") => RegisteredDriver | undefined;
  readonly selectCompute: () => ComputeDriver;
}

const REPOSITORY_RESTART_OBSERVATION_TIMEOUT_MS = 10_000;

export async function readDeploymentInventory(
  dependencies: DeploymentInventoryDependencies,
  principalId: string,
): Promise<Readonly<InstallationDeploymentInventory>> {
  const before = await deploymentInventorySnapshot(dependencies, principalId);
  const computeSelection = dependencies.driverSelection("compute");
  const sandboxSelection = dependencies.driverSelection("sandbox");
  let compute: ComputeDriver | undefined;
  try {
    compute = dependencies.selectCompute();
  } catch {
    // An unavailable implementation cannot supply positive restart evidence.
    compute = undefined;
  }
  const signal = AbortSignal.timeout(REPOSITORY_RESTART_OBSERVATION_TIMEOUT_MS);
  const dispositions = new Map<string, RepositoryWorkerRestartDisposition>();
  // Owner reads must not retain the State transaction or mutate repository custody.
  for (const [revisionId, revision] of before.revisions) {
    dispositions.set(revisionId, await observeRepositoryWorkerRestart(compute, revision, signal));
  }
  // Reauthorize the whole fleet, including newly active Agents and pending deployments.
  // This detects changed selection; it does not replace exclusive maintenance ownership.
  const after = await deploymentInventorySnapshot(dependencies, principalId);
  if (
    !isDeepStrictEqual(before, after) ||
    computeSelection !== dependencies.driverSelection("compute") ||
    sandboxSelection !== dependencies.driverSelection("sandbox") ||
    (compute !== undefined && computeSelection !== undefined && !unchangedDriver(computeSelection))
  ) {
    throw new DependencyUnavailableError(
      "The Agent deployment inventory changed during repository observation. Read it again.",
    );
  }
  return Object.freeze({
    ...after.inventory,
    namespaces: Object.freeze(
      after.inventory.namespaces.map((namespace) =>
        Object.freeze({
          ...namespace,
          agents: Object.freeze(
            namespace.agents.map((agent) => {
              const repositoryWorkerRestart =
                agent.activeRevisionId === undefined
                  ? undefined
                  : dispositions.get(agent.activeRevisionId);
              return Object.freeze({
                ...agent,
                ...(repositoryWorkerRestart === undefined ? {} : { repositoryWorkerRestart }),
              });
            }),
          ),
        }),
      ),
    ),
  });
}

async function observeRepositoryWorkerRestart(
  compute: ComputeDriver | undefined,
  revision: Readonly<AgentRevision> | undefined,
  signal: AbortSignal,
): Promise<RepositoryWorkerRestartDisposition> {
  if (
    signal.aborted ||
    revision === undefined ||
    compute?.id !== revision.compute.id ||
    compute.implementation !== revision.compute.implementation ||
    compute.repositoryWorkerRestartDisposition === undefined
  ) {
    return "unknown";
  }
  let aborted: (() => void) | undefined;
  try {
    const result = await Promise.race([
      compute.repositoryWorkerRestartDisposition(revision, signal),
      new Promise<"unknown">((resolve) => {
        aborted = () => resolve("unknown");
        signal.addEventListener("abort", aborted, { once: true });
      }),
    ]);
    return result === "original-worker-required" ||
      result === "reverification-supported" ||
      result === "not-applicable"
      ? result
      : "unknown";
  } catch {
    return "unknown";
  } finally {
    if (aborted !== undefined) {
      signal.removeEventListener("abort", aborted);
    }
  }
}

async function deploymentInventorySnapshot(
  dependencies: DeploymentInventoryDependencies,
  principalId: string,
) {
  await dependencies.authorize(principalId, "administer", {
    kind: "installation",
    id: dependencies.installationId,
  });
  return dependencies.read(async (state) => {
    const revisions = new Map<string, Readonly<AgentRevision> | undefined>();
    const deploymentsInProgress = new Set<string>();
    // Credential withdrawal targets an active revision without deploying it.
    const deployments = (await state.operations.listUnsettledOperations())
      .filter(
        (operation) =>
          operation.kind === "agent_revision" && operation.target !== "credentials_withdrawn",
      )
      .map(({ namespaceId, resourceId }) => ({
        namespaceId,
        revisionId: resourceId,
        key: `agent_revision:${resourceId}:reconcile`,
      }));
    const workByKey = await state.operations.findWorkByKeys(deployments.map(({ key }) => key));
    for (const { namespaceId, revisionId, key } of deployments) {
      const work = workByKey.get(key);
      if (
        work === undefined ||
        work.namespaceId !== namespaceId ||
        work.revisionId !== revisionId ||
        !isNonEmptyString(work.agentId)
      ) {
        throw new DependencyUnavailableError("The Agent deployment inventory is incomplete.");
      }
      if (work.state === "queued" || work.state === "claimed") {
        deploymentsInProgress.add(`${work.namespaceId}\u0000${work.agentId}`);
      }
    }

    const namespaces = [];
    for (const namespace of await state.namespaces.listNamespaces()) {
      await dependencies.authorize(principalId, "read", {
        kind: "namespace",
        id: namespace.id,
        namespaceId: namespace.id,
      });
      const agents = [];
      for (const agent of await state.agents.listAgents(namespace.id)) {
        await dependencies.authorize(principalId, "read", {
          kind: "agent",
          id: agent.id,
          namespaceId: namespace.id,
        });
        const deploymentInProgress = deploymentsInProgress.has(`${namespace.id}\u0000${agent.id}`);
        if (
          agent.status === "active" &&
          agent.desiredRuntimeState === "running" &&
          agent.activeRevisionId !== undefined &&
          !deploymentInProgress
        ) {
          await dependencies.authorize(principalId, "deploy", {
            kind: "agent",
            id: agent.id,
            namespaceId: namespace.id,
          });
          await dependencies.authorize(principalId, "read", {
            kind: "agent_revision",
            id: agent.activeRevisionId,
            namespaceId: namespace.id,
            parentAgentId: agent.id,
          });
          const revision = await state.revisions.findRevisionForBrowsing(
            namespace.id,
            agent.id,
            agent.activeRevisionId,
          );
          revisions.set(
            agent.activeRevisionId,
            revision !== undefined &&
              !("configurationReadError" in revision) &&
              revision.id === agent.activeRevisionId &&
              revision.namespaceId === namespace.id &&
              revision.agentId === agent.id
              ? revision
              : undefined,
          );
        }
        agents.push(
          Object.freeze({
            id: agent.id,
            status: agent.status,
            desiredRuntimeState: agent.desiredRuntimeState,
            executionMode: agent.executionMode,
            ...(agent.activeRevisionId === undefined
              ? {}
              : { activeRevisionId: agent.activeRevisionId }),
            deploymentInProgress,
          }),
        );
      }
      namespaces.push(
        Object.freeze({
          id: namespace.id,
          status: namespace.status,
          agents: Object.freeze(agents),
        }),
      );
    }
    return {
      inventory: Object.freeze({
        installationId: dependencies.installationId,
        namespaces: Object.freeze(namespaces),
      }),
      revisions,
    };
  });
}
