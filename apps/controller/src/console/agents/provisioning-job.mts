import type { AgentProvisioningStatusWire } from "@openclaw-enterprise/contracts";

function fields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

// Admission wraps the job; status and retry return it directly. The first response must name the
// client's request, then later responses must also identify that same job in this Namespace.
export function provisioningJob(
  value: unknown,
  provisionPath: string,
  requestId: string,
  expectedUrl?: string,
): AgentProvisioningStatusWire & { requestId: string } {
  const response = fields(value);
  const job = fields(response.provisioning ?? value);
  const { workId, url, status } = job;
  if (
    job.requestId !== requestId ||
    typeof workId !== "string" ||
    !workId ||
    workId === "." ||
    workId === ".." ||
    url !== `${provisionPath}/${encodeURIComponent(workId)}` ||
    (expectedUrl !== undefined && url !== expectedUrl) ||
    (status !== "queued" && status !== "running" && status !== "failed" && status !== "succeeded")
  ) {
    // An unusable success is not a refusal. Create keeps its request ID and any confirmed job.
    throw new Error("The provisioning response did not identify the expected job.");
  }
  return job as AgentProvisioningStatusWire & { requestId: string };
}
