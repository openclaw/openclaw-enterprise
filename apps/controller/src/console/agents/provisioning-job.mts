import type { AgentProvisioningStatusWire } from "@openclaw-enterprise/contracts";
import { responseFields } from "../api-client.mjs";

type ProvisioningJob = Pick<AgentProvisioningStatusWire, "url" | "status"> & {
  agentId?: string;
  revisionId?: string;
  error?: { code: string; message?: string };
  progress?: { lastAttempt: { code: string; message: string } };
};

// Match the contracts' prefixed lowercase v4 UUIDs without loading server schemas in the browser.
function resourceId(value: unknown, prefix: "agt_" | "rev_"): value is string {
  return (
    typeof value === "string" &&
    value.length === 40 &&
    value.startsWith(prefix) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.slice(4))
  );
}

// Admission wraps the job; status and retry return it directly. The first response must name the
// client's request, then later responses must also identify that same job in this Namespace.
export function provisioningJob(
  value: unknown,
  provisionPath: string,
  requestId: string,
  expectedUrl?: string,
): ProvisioningJob {
  const response = responseFields(value);
  const job = responseFields(response.provisioning ?? value);
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
  const result: ProvisioningJob = { url, status };
  for (const [key, prefix] of [
    ["agentId", "agt_"],
    ["revisionId", "rev_"],
  ] as const) {
    if (key in job) {
      const id = job[key];
      if (!resourceId(id, prefix)) {
        throw new Error("The provisioning response did not identify a valid Agent or revision.");
      }
      result[key] = id;
    }
  }
  const error = responseFields(job.error);
  if (typeof error.code === "string" && error.code.trim()) {
    result.error = { code: error.code };
    if (typeof error.message === "string" && error.message.trim()) {
      result.error.message = error.message;
    }
  }
  const attempt = responseFields(responseFields(job.progress).lastAttempt);
  if (
    typeof attempt.code === "string" &&
    attempt.code.trim() &&
    typeof attempt.message === "string" &&
    attempt.message.trim()
  ) {
    result.progress = { lastAttempt: { code: attempt.code, message: attempt.message } };
  }
  return result;
}
