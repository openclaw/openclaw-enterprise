import assert from "node:assert/strict";
import test from "node:test";
import type { AgentProvisioningStatusWire } from "../../packages/contracts/src/api/resources.ts";
import { provisioningJob } from "../../apps/controller/src/console/agents/provisioning-job.mts";

test("the Console distinguishes the stored provisioning request from the HTTP request", () => {
  const path = "/namespaces/test/agents/provision";
  // Work IDs are opaque and may contain punctuation. Keep the controller's encoded path exactly.
  const workId = "agent-provisioning:example";
  const url = `${path}/${encodeURIComponent(workId)}`;
  const legacy: AgentProvisioningStatusWire = {
    workId,
    url,
    status: "queued",
    phase: "admitted",
    attemptCount: 0,
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const requestId = `req_${crypto.randomUUID()}`;
  const job = { ...legacy, requestId };
  assert.equal(provisioningJob({ provisioning: job }, path, requestId), job);
  assert.equal(provisioningJob(job, path, requestId, url), job);

  for (const response of [
    { provisioning: legacy, meta: { requestId } },
    { ...job, url: `${path}/${workId}` },
    { ...job, workId: "..", url: `${path}/..` },
  ]) {
    assert.throws(() => provisioningJob(response, path, requestId), /did not identify/);
  }
});
