import { asRecord } from "../../packages/utils/src/index.ts";

export function hasReadyCondition(pod: unknown): boolean {
  const conditions = asRecord(asRecord(pod)?.status)?.conditions;
  if (!Array.isArray(conditions)) {
    return false;
  }
  return conditions.some((condition: unknown) => {
    const fields = asRecord(condition);
    return fields?.type === "Ready" && fields.status === "True";
  });
}

export async function readReadyAgentPod(
  resources: (kind: "pods", namespace: string) => Promise<readonly unknown[] | undefined>,
  topology: { placement: string; agent: { id: string }; revision: { id: string } },
  revisionId = topology.revision.id,
  previousUid?: string,
) {
  const pods = await resources("pods", topology.placement);
  return pods?.find((pod): pod is { metadata: { name: string; uid: string } } => {
    const record = asRecord(pod);
    const metadata = asRecord(record?.metadata);
    const labels = asRecord(metadata?.labels);
    return (
      typeof metadata?.name === "string" &&
      metadata.name !== "" &&
      typeof metadata.uid === "string" &&
      metadata.uid !== "" &&
      metadata.uid !== previousUid &&
      metadata.deletionTimestamp === undefined &&
      labels?.["openclaw.dev/workload-role"] === "agent" &&
      labels["openclaw.dev/agent"] === topology.agent.id &&
      labels["openclaw.dev/revision"] === revisionId &&
      asRecord(record?.status)?.phase === "Running" &&
      hasReadyCondition(pod)
    );
  });
}
