import {
  freezeAgentRevision,
  type AgentRevision,
  type ComputeDriver,
  type ExecutionAdmission,
} from "@openclaw-enterprise/contracts";

export function executionAdmissionFor(egressPlan: AgentRevision["egressPlan"]): ExecutionAdmission {
  if (egressPlan === undefined) {
    return { version: 2, mode: "unprotected" };
  }
  if (egressPlan.repositoryGit && egressPlan.policyReductionVersion === 2) {
    return { version: 7, mode: "protected" };
  }
  if (egressPlan.repositoryGitAuthorization === "network-policy") {
    return { version: 9, mode: "protected" };
  }
  if (egressPlan.repositoryGitAuthorization === "request-hook-observed") {
    return { version: 6, mode: "protected" };
  }
  if (egressPlan.repositoryGitAuthorization === "online-request") {
    return { version: 5, mode: "protected" };
  }
  return { version: egressPlan.repositoryGit ? 4 : 3, mode: "protected" };
}

export function prepareComputeRevision(
  compute: ComputeDriver,
  revisionDraft: AgentRevision,
): Readonly<AgentRevision> {
  const computeAdmission = compute.admitRevision?.(freezeAgentRevision(revisionDraft));
  const admittedDraft = freezeAgentRevision({
    ...revisionDraft,
    compute: {
      ...revisionDraft.compute,
      ...(computeAdmission === undefined ? {} : { admission: computeAdmission }),
    },
  });
  const runtimeInputs = compute.snapshotRuntimeInputs?.(admittedDraft);
  return freezeAgentRevision({
    ...admittedDraft,
    compute: {
      ...admittedDraft.compute,
      ...(runtimeInputs === undefined ? {} : { runtimeInputs }),
    },
  });
}
