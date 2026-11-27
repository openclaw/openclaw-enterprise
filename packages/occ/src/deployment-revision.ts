import {
  freezeAgentRevision,
  type AgentRevision,
  type ComputeDriver,
} from "@openclaw-enterprise/contracts";

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
