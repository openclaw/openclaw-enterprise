import type {
  Agent,
  AgentRevision,
  EgressInstallation,
  Namespace,
} from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError, type PostgresPlatformState } from "@openclaw-enterprise/occ";
import { isDeepStrictEqual } from "node:util";

function currentProtectedExecution(
  namespace: Readonly<Namespace> | undefined,
  agent: Readonly<Agent> | undefined,
  servicePrincipalId: string,
): boolean {
  return (
    namespace?.status === "ready" &&
    agent?.status === "active" &&
    agent.desiredRuntimeState === "running" &&
    agent.servicePrincipalId === servicePrincipalId
  );
}

function usesCredentialSource(revision: Readonly<AgentRevision>, sourceId: string) {
  return revision.egressPlan?.routes.some((route) => route.binding.source.source.id === sourceId);
}

export function revisionEgressReceipts(
  persistence: Pick<PostgresPlatformState, "read" | "transactWithQueue">,
  revision: Readonly<AgentRevision>,
) {
  async function recordEgressInstallation(installation: EgressInstallation) {
    await persistence.transactWithQueue(async (state, queue) => {
      const namespace = await state.namespaces.lockNamespace(revision.namespaceId);
      const agent = await state.agents.lockAgent(revision.namespaceId, revision.agentId);
      if (!currentProtectedExecution(namespace, agent, revision.servicePrincipalId)) {
        throw new Error("The protected execution is no longer current.");
      }
      const current = await state.credentialSources.findRevisionEgressInstallation(
        revision.namespaceId,
        revision.id,
      );
      const active = await state.credentialSources.findEgressInstallation(
        installation.sender.id,
        installation.sandboxId,
      );
      // Re-observing a current receipt cannot reactivate a retired execution.
      if (
        current &&
        isDeepStrictEqual(active, current) &&
        isDeepStrictEqual(current, {
          ...installation,
          installedAt: current.installedAt,
        })
      ) {
        return;
      }
      const newest = (
        await state.revisions.listRevisionMetadata(revision.namespaceId, revision.agentId)
      ).at(-1);
      const deployment = await queue.findWork(`agent_revision:${revision.id}:reconcile`);
      if (
        newest?.id !== revision.id ||
        deployment === undefined ||
        deployment.state === "failed_permanent" ||
        current ||
        !isDeepStrictEqual(installation.plan, revision.egressPlan) ||
        (
          await state.credentialSources.listCredentialWithdrawals(revision.namespaceId, revision.id)
        ).some(({ credentialSourceId }) => usesCredentialSource(revision, credentialSourceId))
      ) {
        throw new Error("Egress receipt does not match the current admitted policy.");
      }
      await state.credentialSources.recordEgressInstallation(installation);
    });
  }

  function currentEgressInstallation() {
    return persistence.read(async (view) => {
      const { namespaceId, agentId, servicePrincipalId, id } = revision;
      const namespace = await view.namespaces.findNamespace(namespaceId);
      const agent = await view.agents.findAgent(namespaceId, agentId);
      const newest = (await view.revisions.listRevisionMetadata(namespaceId, agentId)).at(-1);
      const current = await view.revisions.findRevision(namespaceId, agentId, id);
      if (
        !currentProtectedExecution(namespace, agent, servicePrincipalId) ||
        newest?.id !== id ||
        current?.executionAdmission.mode !== "protected" ||
        !isDeepStrictEqual(current.egressPlan, revision.egressPlan)
      ) {
        if (revision.egressPlan?.policyReductionVersion !== undefined) {
          throw new DependencyUnavailableError("The protected execution is no longer current.");
        }
        return undefined;
      }
      const withdrawals = await view.credentialSources.listCredentialWithdrawals(namespaceId, id);
      const reductions = await view.credentialSources.listCredentialPolicyReductions(
        namespaceId,
        id,
      );
      if (
        reductions.some((reduction) => !reduction.observed) ||
        (revision.egressPlan?.policyReductionVersion &&
          withdrawals.some(
            (withdrawal) =>
              usesCredentialSource(revision, withdrawal.credentialSourceId) &&
              !reductions.some(
                (reduction) =>
                  reduction.bindingId === `policy:source:${withdrawal.credentialSourceId}` &&
                  reduction.observed,
              ),
          ))
      ) {
        throw new DependencyUnavailableError("Credential policy reduction is not observed.");
      }
      const receipt = await view.credentialSources.findRevisionEgressInstallation(namespaceId, id);
      if (receipt === undefined) {
        return undefined;
      }
      const active = await view.credentialSources.findEgressInstallation(
        receipt.sender.id,
        receipt.sandboxId,
      );
      return isDeepStrictEqual(active, receipt) ? receipt : undefined;
    });
  }

  return { recordEgressInstallation, currentEgressInstallation };
}
