import { isDeepStrictEqual } from "node:util";
import type {
  Agent,
  AgentRevision,
  AgentRevisionMetadata,
  Namespace,
  ProxyPlan,
  CredentialWithdrawal,
  EgressInstallation,
  ComputeRevisionContext,
} from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError, type PlatformStateStore } from "@openclaw-enterprise/occ";

type AdmittedExecution = Pick<
  AgentRevision,
  "namespaceId" | "agentId" | "id" | "servicePrincipalId" | "egressPlan"
>;

// These operations retain the admission but read current state only when Compute invokes them.
export function revisionEgressInstallation(
  state: Pick<PlatformStateStore, "read" | "transact">,
  revision: AdmittedExecution,
): Pick<ComputeRevisionContext, "recordEgressInstallation" | "currentEgressInstallation"> {
  if (revision.egressPlan === undefined) {
    return {};
  }
  return {
    recordEgressInstallation: (installation) => recordInstallation(state, revision, installation),
    currentEgressInstallation: () => readCurrentInstallation(state, revision),
  };
}

async function recordInstallation(
  state: Pick<PlatformStateStore, "transact">,
  revision: Pick<AdmittedExecution, "namespaceId" | "agentId" | "id" | "egressPlan">,
  installation: EgressInstallation,
): Promise<void> {
  await state.transact(async (unit) => {
    await unit.agents.lockAgent(revision.namespaceId, revision.agentId);
    const current = await unit.credentialSources.findRevisionEgressInstallation(
      revision.namespaceId,
      revision.id,
    );
    // Re-observing the same installation may advance its timestamp, not its authority.
    if (
      current &&
      isDeepStrictEqual(current, {
        ...installation,
        installedAt: current.installedAt,
      })
    ) {
      return;
    }
    if (current || !isDeepStrictEqual(installation.plan, revision.egressPlan)) {
      throw new Error("Egress receipt does not match the current admitted policy.");
    }
    const withdrawals = await unit.credentialSources.listCredentialWithdrawals(
      revision.namespaceId,
      revision.id,
    );
    if (
      withdrawals.some(({ credentialSourceId }) =>
        planRoutesSource(revision.egressPlan, credentialSourceId),
      )
    ) {
      throw new Error("Egress receipt does not match the current admitted policy.");
    }
    await unit.credentialSources.recordEgressInstallation(installation);
  });
}

function readCurrentInstallation(
  state: Pick<PlatformStateStore, "read">,
  revision: AdmittedExecution,
): Promise<Readonly<EgressInstallation> | undefined> {
  return state.read(async (view) => {
    const { namespaceId, agentId, id } = revision;
    const namespace = await view.namespaces.findNamespace(namespaceId);
    const agent = await view.agents.findAgent(namespaceId, agentId);
    const newest = (await view.revisions.listRevisionMetadata(namespaceId, agentId)).at(-1);
    const current = await view.revisions.findRevision(namespaceId, agentId, id);
    if (!isAdmittedExecutionCurrent(revision, namespace, agent, newest, current)) {
      if (revision.egressPlan?.policyReductionVersion !== undefined) {
        throw new DependencyUnavailableError("The protected execution is no longer current.");
      }
      return undefined;
    }
    const withdrawals = await view.credentialSources.listCredentialWithdrawals(namespaceId, id);
    const reductions = await view.credentialSources.listCredentialPolicyReductions(namespaceId, id);
    if (
      reductions.some((reduction) => !reduction.observed) ||
      !routedWithdrawalsAreReduced(revision.egressPlan, withdrawals, reductions)
    ) {
      throw new DependencyUnavailableError("Credential policy reduction is not observed.");
    }
    return view.credentialSources.findRevisionEgressInstallation(namespaceId, id);
  });
}

function isAdmittedExecutionCurrent(
  admitted: AdmittedExecution,
  namespace: Readonly<Namespace> | undefined,
  agent: Readonly<Agent> | undefined,
  newest: Readonly<AgentRevisionMetadata> | undefined,
  current: Readonly<AgentRevision> | undefined,
): boolean {
  if (
    namespace?.status !== "ready" ||
    agent?.status !== "active" ||
    agent.desiredRuntimeState !== "running"
  ) {
    return false;
  }
  if (agent.servicePrincipalId !== admitted.servicePrincipalId || newest?.id !== admitted.id) {
    return false;
  }
  return (
    current?.executionAdmission.mode === "protected" &&
    isDeepStrictEqual(current.egressPlan, admitted.egressPlan)
  );
}

function planRoutesSource(plan: ProxyPlan | undefined, sourceId: string): boolean {
  return plan?.routes.some((route) => route.binding.source.source.id === sourceId) ?? false;
}

function routedWithdrawalsAreReduced(
  plan: ProxyPlan | undefined,
  withdrawals: readonly Readonly<CredentialWithdrawal>[],
  observedReductions: readonly { readonly bindingId: string }[],
): boolean {
  if (!plan?.policyReductionVersion) {
    return true;
  }
  const observedBindings = new Set(observedReductions.map((reduction) => reduction.bindingId));
  return withdrawals.every(
    ({ credentialSourceId }) =>
      !planRoutesSource(plan, credentialSourceId) ||
      observedBindings.has(`policy:source:${credentialSourceId}`),
  );
}
