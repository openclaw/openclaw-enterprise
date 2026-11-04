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
  assert.deepEqual(provisioningJob({ provisioning: job }, path, requestId), {
    url,
    status: "queued",
  });
  assert.deepEqual(provisioningJob(job, path, requestId, url), { url, status: "queued" });

  for (const response of [
    { provisioning: legacy, meta: { requestId } },
    legacy,
    { ...job, requestId: "another-request" },
    { ...job, url: `/namespaces/other/agents/provision/${encodeURIComponent(workId)}` },
    { ...job, status: "unknown" },
    { ...job, url: `${path}/${workId}` },
    { ...job, workId: "..", url: `${path}/..` },
  ]) {
    assert.throws(() => provisioningJob(response, path, requestId), /did not identify/);
  }
  assert.throws(() => provisioningJob(job, path, requestId, `${url}-other`), /did not identify/);
});

test("the Console projects only safe consumed provisioning fields", () => {
  const path = "/namespaces/test/agents/provision";
  const url = `${path}/opaque%2Fjob%3Fid`;
  const job = { requestId: "request", workId: "opaque/job?id", url, status: "failed" };
  const agentId = "agt_01234567-89ab-4cde-8fab-0123456789ab";
  const revisionId = "rev_01234567-89ab-4cde-bfab-0123456789ab";
  const parse = (value: unknown) => provisioningJob(value, path, job.requestId, url);

  // Unused wire fields need not be present or valid; identifiers used in links must be exact.
  assert.deepEqual(
    parse({
      ...job,
      agentId,
      revisionId,
      phase: {},
      attemptCount: -1,
      updatedAt: false,
      configurationId: 17,
    }),
    { url, status: "failed", agentId, revisionId },
  );
  assert.equal(encodeURIComponent(agentId), agentId);
  assert.equal(encodeURIComponent(revisionId), revisionId);
  for (const [key, valid] of [
    ["agentId", agentId],
    ["revisionId", revisionId],
  ] as const) {
    for (const invalid of [
      17,
      null,
      undefined,
      "",
      {},
      valid.toUpperCase(),
      valid.replace("4cde", "5cde"),
      valid.replace(/-[89ab]fab-/, "-7fab-"),
      `${valid}/extra`,
      `${valid}\n`,
      key === "agentId" ? revisionId : agentId,
    ]) {
      // A present invalid identity must not become an absent identity and enable false recovery.
      assert.throws(
        () => parse({ ...job, agentId, revisionId, [key]: invalid }),
        /did not identify/,
      );
    }
  }
  assert.throws(() => parse({ ...job, agentId: 17, revisionId: 17 }), /did not identify/);

  // Keep retry and neutral-outcome codes even when display text must use the generic fallback.
  for (const code of [
    "PROVISIONING_FAILED",
    "PROVISIONING_REJECTED",
    "PROVISIONING_CANCELLED",
    "REVISION_STOPPED",
    "REVISION_SUPERSEDED",
    "UNKNOWN",
  ]) {
    assert.deepEqual(parse({ ...job, error: { code, message: "Useful reason." } }), {
      url,
      status: "failed",
      error: { code, message: "Useful reason." },
    });
    for (const message of [{ detail: "synthetic" }, undefined, null, "", "   "]) {
      assert.deepEqual(parse({ ...job, error: { code, message } }), {
        url,
        status: "failed",
        error: { code },
      });
    }
  }
  // Display text survives an absent or malformed code without inventing an outcome code.
  const message = "Deployment was superseded.";
  assert.deepEqual(parse({ ...job, agentId, revisionId, error: { message } }), {
    url,
    status: "failed",
    agentId,
    revisionId,
    error: { message },
  });
  for (const code of [undefined, null, {}, 17, "", "   "]) {
    assert.deepEqual(parse({ ...job, agentId, revisionId, error: { code, message } }), {
      url,
      status: "failed",
      agentId,
      revisionId,
      error: { message },
    });
  }
  assert.deepEqual(parse({ ...job, agentId, revisionId, error: { code: "UNKNOWN", message } }), {
    url,
    status: "failed",
    agentId,
    revisionId,
    error: { code: "UNKNOWN", message },
  });
  for (const error of [undefined, null, {}, { code: {}, message: {} }, { code: " " }]) {
    assert.deepEqual(parse({ ...job, error }), { url, status: "failed" });
  }
  for (const code of [
    "NAMESPACE_POD_QUOTA_EXCEEDED",
    "REVISION_IMAGE_PULL_FAILED",
    "AGENT_STOP_YIELDED",
    "PROVISIONING_DEPLOYMENT_PENDING",
  ]) {
    const lastAttempt = { code, message: "Waiting for deployment." };
    assert.deepEqual(parse({ ...job, status: "running", progress: { lastAttempt } }), {
      url,
      status: "running",
      progress: { lastAttempt },
    });
  }
  for (const progress of [
    undefined,
    null,
    {},
    { lastAttempt: null },
    { lastAttempt: { code: "WAIT", message: {} } },
    { lastAttempt: { code: {}, message: "Waiting." } },
    { lastAttempt: { code: "WAIT", message: " " } },
    { lastAttempt: { code: "", message: "Waiting." } },
  ]) {
    assert.deepEqual(parse({ ...job, progress }), { url, status: "failed" });
  }
  assert.deepEqual(parse({ ...job, status: "succeeded", agentId, revisionId }), {
    url,
    status: "succeeded",
    agentId,
    revisionId,
  });
});
