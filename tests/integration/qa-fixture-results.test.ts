import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

test("QA matrix summary refuses malformed evidence without printing its contents", async (t) => {
  const directory = await temporaryDirectory(t, "qa-summary-");
  const evidenceDirectory = join(directory, "qa-matrix-evidence");
  const summary = join(directory, "summary.md");
  const existingSummary = "Previous summary content.\n";
  const marker = "invented report text";
  const script = fileURLToPath(new URL("../../scripts/ci/qa-matrix-summary.ts", import.meta.url));
  await mkdir(evidenceDirectory);
  await writeFile(summary, existingSummary);

  const malformedEvidence: [name: string, evidence: string][] = [
    ["invalid JSON", `not JSON: ${marker}`],
    ["missing selection", JSON.stringify({ scope: marker, outcomes: [] })],
    [
      "invalid scenario list",
      JSON.stringify({
        scope: marker,
        selection: [{ cell: "compose/Codex", scenarios: "model-ui", unselected: [] }],
        outcomes: [],
      }),
    ],
    ["null report", "null"],
  ];
  for (const [name, evidence] of malformedEvidence) {
    await t.test(name, async () => {
      await writeFile(join(evidenceDirectory, "matrix.json"), evidence);
      const child = spawnSync(process.execPath, [script], {
        encoding: "utf8",
        env: { RUNNER_TEMP: directory, GITHUB_STEP_SUMMARY: summary },
        timeout: 5_000,
      });
      assert.ifError(child.error);
      assert.equal(child.status, 1);
      assert.equal(child.stdout, "");
      assert.equal(
        child.stderr,
        "Malformed QA matrix evidence: expected a JSON report with scope, selection, and outcomes.\n",
      );
      assert.equal(await readFile(summary, "utf8"), existingSummary);
    });
  }
});

test("QA matrix summary distinguishes an initial snapshot from recorded outcomes", async (t) => {
  const { createQaReport } = await import("../helpers/qa-report.mjs");
  const directory = await temporaryDirectory(t, "qa-summary-");
  const evidenceDirectory = join(directory, "qa-matrix-evidence");
  const script = fileURLToPath(new URL("../../scripts/ci/qa-matrix-summary.ts", import.meta.url));
  await mkdir(evidenceDirectory);

  async function summarize(name: string) {
    const summary = join(directory, name);
    const child = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { RUNNER_TEMP: directory, GITHUB_STEP_SUMMARY: summary },
      timeout: 5_000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0);
    assert.equal(child.stderr, "");
    return readFile(summary, "utf8");
  }

  assert.match(await summarize("missing.md"), /No scenario results were produced/);

  const { stage, save } = createQaReport(join(evidenceDirectory, "matrix.json"), {
    scope: "partial",
    selection: [{ cell: "compose/Codex", scenarios: ["model-ui"], unselected: [] }],
  });
  await save();
  const initial = await summarize("initial.md");
  assert.match(initial, /Scope: partial/);
  assert.match(initial, /compose\/Codex \| model-ui \| none/);
  assert.match(initial, /No stage outcomes were recorded/);
  assert.doesNotMatch(initial, /Stages absent from this table/);
  assert.doesNotMatch(initial, /\| Cell \| Scenario \| Stage \| Outcome \|/);

  await stage(t, "compose/Codex", "synthetic stage", () => true, "model-ui");
  const populated = await summarize("populated.md");
  assert.match(populated, /compose\/Codex \| model-ui \| synthetic stage \| passed/);
  assert.doesNotMatch(populated, /No stage outcomes were recorded/);
});

test("native cron positive control requires its own successful completed run", async (t) => {
  const { assertNativeCronRunSucceeded } = await import("../helpers/native-cron-evidence.ts");
  const accepted = { ok: true, enqueued: true, runId: "control-run" };
  const finished = {
    jobId: "control-job",
    runId: "control-run",
    action: "finished",
    status: "ok",
  };
  type CronAcknowledgement = {
    ok: boolean;
    enqueued?: boolean;
    runId?: string;
    ran?: boolean;
    reason?: string;
  };
  type CronEntry = { jobId: string; runId: string; action: string; status: string };
  type CronRequest = Parameters<typeof assertNativeCronRunSucceeded>[0]["request"];
  type CronCall = { method: Parameters<CronRequest>[0]; params: Parameters<CronRequest>[1] };
  async function exercise(ack: CronAcknowledgement, entry: CronEntry | undefined) {
    const calls: CronCall[] = [];
    const proof = await assertNativeCronRunSucceeded({
      jobId: "control-job",
      async request(method, params) {
        calls.push({ method, params });
        if (method === "cron.run") {
          return ack;
        }
        assert.equal(method, "cron.runs");
        return { entries: entry === undefined ? [] : [entry] };
      },
      // One observation represents completion or exhausted polling, without a real timer.
      waitFor: async (_description, inspect) => inspect(),
    });
    return { proof, calls };
  }

  await t.test("records the accepted run only after its successful terminal result", async () => {
    const { proof, calls } = await exercise(accepted, finished);
    assert.deepEqual(proof, { jobId: "control-job", runId: "control-run", status: "ok" });
    assert.deepEqual(calls, [
      {
        method: "cron.run",
        params: { id: "control-job", mode: "force", waitTimeoutMs: 5_000 },
      },
      { method: "cron.runs", params: { id: "control-job", runId: "control-run", limit: 1 } },
    ]);
  });
  const rejectedRuns: [
    name: string,
    acknowledgement: CronAcknowledgement,
    entry: CronEntry,
    expected: RegExp,
  ][] = [
    [
      "a successful RPC that did not run the job",
      { ok: true, ran: false, reason: "invalid-spec" },
      finished,
      /must enqueue a run/,
    ],
    ["a different completed run", accepted, { ...finished, runId: "other-run" }, /enqueued run/],
    ["an unfinished run", accepted, { ...finished, action: "started" }, /must finish/],
    ["a failed terminal run", accepted, { ...finished, status: "error" }, /must succeed/],
  ];
  for (const [name, ack, entry, expected] of rejectedRuns) {
    await t.test(`rejects ${name}`, async () => {
      await assert.rejects(exercise(ack, entry), expected);
    });
  }
});
