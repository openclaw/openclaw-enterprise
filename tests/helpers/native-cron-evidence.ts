import assert from "node:assert/strict";
import { asRecord } from "../../packages/utils/src/index.ts";

type CronRequest = (
  ...args:
    | [method: "cron.run", params: { id: string; mode: "force"; waitTimeoutMs: number }]
    | [method: "cron.runs", params: { id: string; runId: string; limit: number }]
) => Promise<unknown>;

type FinishedRun = { action: "finished"; jobId: string; runId: string; status: string };

type CronEvidenceOptions = {
  request: CronRequest;
  waitFor: (
    description: string,
    observe: () => Promise<FinishedRun | undefined>,
    timeoutMs: number,
  ) => Promise<FinishedRun | undefined>;
  jobId: string;
};

export async function assertNativeCronRunSucceeded({
  request,
  waitFor,
  jobId,
}: CronEvidenceOptions) {
  const accepted = asRecord(
    await request("cron.run", { id: jobId, mode: "force", waitTimeoutMs: 5_000 }),
  );
  assert.equal(accepted?.ok, true, "human command request must succeed");
  assert.equal(accepted?.enqueued, true, "human command request must enqueue a run");
  const runId = accepted?.runId;
  assert.ok(typeof runId === "string", "human command request must identify its run");
  assert.ok(runId.length > 0, "human command run ID must not be empty");
  const run = await waitFor(
    "human command run completion",
    async () => {
      const page = asRecord(await request("cron.runs", { id: jobId, runId, limit: 1 }));
      const entries: readonly unknown[] = Array.isArray(page?.entries) ? page.entries : [];
      const entry = asRecord(entries[0]);
      if (entry?.action !== "finished") {
        return undefined;
      }
      assert.ok(
        typeof entry.jobId === "string",
        "human command result must identify its control job",
      );
      assert.ok(
        typeof entry.runId === "string",
        "human command result must identify its enqueued run",
      );
      assert.ok(typeof entry.status === "string", "human command run must have a status");
      return { action: entry.action, jobId: entry.jobId, runId: entry.runId, status: entry.status };
    },
    60_000,
  );
  assert.ok(run?.action === "finished", "human command run must finish");
  assert.equal(run.jobId, jobId, "human command result must belong to its control job");
  assert.equal(run.runId, runId, "human command result must belong to its enqueued run");
  assert.equal(run.status, "ok" as const, "human command run must succeed");
  return { jobId, runId, status: run.status };
}
