import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { temporaryDirectory } from "../helpers/temporary-directory.ts";

import { array, jsonRecord, present, record, text } from "./full-integration-json-fixture.ts";
import { reuseFixture } from "./full-integration-reuse-fixture.ts";
import {
  jobStateProgram,
  parseWorkflow,
  workflowCondition,
} from "./full-integration-workflow-fixture.ts";

function summaryIssues(stdout: string) {
  return array(jsonRecord(stdout).issues).map(record);
}

export async function fullIntegrationReuseCase(t: TestContext): Promise<void> {
  const directory = await temporaryDirectory(t, "reuse-plan-");
  const output = join(directory, "output");
  const plan = spawnSync(process.execPath, ["scripts/ci/full-integration-reuse.ts", "plan"], {
    encoding: "utf8",
    env: {
      ...process.env,
      RUNNER_TEMP: directory,
      GITHUB_OUTPUT: output,
      REUSED_LANES: '["postgres"]',
      REUSE_UPLOADED: "success",
    },
  });
  assert.equal(plan.status, 0, plan.stderr);
  const values: Record<string, unknown> = Object.fromEntries(
    (await readFile(output, "utf8"))
      .trim()
      .split("\n")
      .map((line) => {
        const at = line.indexOf("=");
        const value: unknown = JSON.parse(line.slice(at + 1));
        return [line.slice(0, at), value];
      }),
  );
  assert.deepEqual(values.lanes, ["postgres"]);
  assert.equal(array(values.matrix).length, 16);
  assert.ok(!array(values.matrix).some((row) => record(row).lane === "postgres"));
  const workflow = await readFile(
    new URL("../../.github/workflows/full-integration-execution.yml", import.meta.url),
    "utf8",
  );
  const execution = parseWorkflow(workflow);
  const allRows: unknown = JSON.parse(
    await readFile("scripts/ci/full-integration-lanes.json", "utf8"),
  );
  const freshStep = present(present(execution.jobs.preflight).steps).find(
    (step) => step.id === "fresh-plan",
  );
  assert.ok(freshStep, "preflight must publish fallback independently of reuse");
  const freshOutput = join(directory, "fresh-output");
  const fresh = spawnSync("bash", ["-e", "-c", text(freshStep.run)], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: freshOutput },
  });
  assert.equal(fresh.status, 0, fresh.stderr);
  const freshMatrix = (await readFile(freshOutput, "utf8")).trim().slice("matrix=".length);
  assert.deepEqual(JSON.parse(freshMatrix), allRows);
  assert.equal(
    workflowCondition(record(present(execution.jobs.preflight).outputs).matrix, {
      steps: { "fresh-plan": { outputs: { matrix: freshMatrix } } },
    }),
    freshMatrix,
  );
  assert.equal(present(execution.jobs["ci-reuse"])["continue-on-error"], true);
  for (const outcome of ["failure", "cancelled", "skipped", "success"]) {
    const published = workflowCondition(
      record(present(execution.jobs["ci-reuse"]).outputs).matrix,
      {
        steps: { plan: { outcome, outputs: { matrix: JSON.stringify(values.matrix) } } },
      },
    );
    assert.equal(published, outcome === "success" ? JSON.stringify(values.matrix) : "");
  }
  const matrixJob = present(execution.jobs["pr-safe-same-sha"]);
  const retained = present(present(execution.jobs["full-aggregate"]).steps).find(
    (step) => step.name === "Download committed reused results",
  );
  assert.ok(retained, "retained evidence must have a separately gated download");
  assert.ok(!text(record(retained.with).pattern).startsWith("full-results-"));
  assert.equal(retained.uses, "./.github/actions/download-results");
  const freshDownload = present(present(execution.jobs["full-aggregate"]).steps).find(
    (step) => step.name === "Download full integration results",
  );
  assert.notEqual(
    record(retained.with).path,
    record(present(freshDownload).with).path,
    "retry cleanup must not remove fresh results",
  );
  const combine = present(present(execution.jobs["full-aggregate"]).steps).find(
    (step) => step.name === "Combine committed reused results",
  );
  for (const outcome of ["success", "failure", "skipped", "cancelled"]) {
    assert.equal(
      workflowCondition(present(combine).if, { steps: { "reused-results": { outcome } } }),
      outcome === "success",
    );
  }

  const reuseJob = present(execution.jobs["ci-reuse"]);
  const upload = present(present(reuseJob.steps).find((step) => step.id === "upload"));
  assert.equal(record(upload.with).name, record(retained.with).pattern);
  // A failed optional job may expose partial outputs after uploading. Neither
  // those outputs nor an orphaned artifact may displace fresh execution.
  for (const reuse of [
    {
      result: "success",
      outputs: { matrix: JSON.stringify(values.matrix), lanes: '["postgres"]' },
    },
    ...["failure", "skipped", "cancelled", "success"].map((result) => ({
      result,
      outputs: { matrix: "", lanes: "" },
    })),
    {
      result: "failure",
      outputs: { matrix: JSON.stringify(values.matrix), lanes: '["postgres"]' },
    },
  ]) {
    const committed = reuse.result === "success" && reuse.outputs.matrix !== "";
    const context = {
      needs: {
        "ci-reuse": reuse,
        preflight: { result: "success", outputs: { matrix: freshMatrix, run_all: "true" } },
      },
      github: {
        repository: "openclaw/openclaw-enterprise",
        ref: "refs/heads/main",
        ref_type: "branch",
        run_attempt: "1",
        event_name: "schedule",
      },
      fromJSON: JSON.parse,
    };
    assert.deepEqual(
      workflowCondition(record(record(matrixJob.strategy).matrix).include, context),
      committed ? values.matrix : allRows,
    );
    assert.equal(workflowCondition(retained.if, context), committed);
    assert.equal(workflowCondition(matrixJob.if, context), true);
    assert.equal(workflowCondition(matrixJob.if, { ...context, cancelled: () => true }), false);
  }
  const script = jobStateProgram(workflow);
  const jobs = array(present(execution.jobs["full-aggregate"]).needs).map(text);
  const execute = async (
    result: string,
    reused = ["postgres"],
    parent = "failure",
    matrix = JSON.stringify(values.matrix),
  ) => {
    const aggregated = spawnSync(process.execPath, ["--input-type=commonjs"], {
      input: script,
      encoding: "utf8",
      env: {
        RUNNER_TEMP: directory,
        SELECTED_LANE: "all",
        REUSED_LANES: JSON.stringify(reused),
        NEEDS_JSON: JSON.stringify({
          ...Object.fromEntries(jobs.map((name) => [name, { result: "success" }])),
          "ci-reuse": { result, outputs: { matrix } },
          "pr-safe-same-sha": { result: parent },
        }),
      },
    });
    assert.equal(aggregated.status, 0, aggregated.stderr);
    return jsonRecord(await readFile(join(directory, "needs.json"), "utf8"));
  };
  for (const result of ["success", "failure", "skipped"]) {
    const needs = await execute(result);
    assert.deepEqual(needs.postgres, result === "success" ? { result: "success" } : undefined);
    assert.equal(record(needs["pr-safe-same-sha"]).result, "failure");
    assert.equal(
      array(record(needs["pr-safe-same-sha"]).lanes).includes("postgres"),
      result !== "success",
    );
    assert.ok(array(record(needs["pr-safe-same-sha"]).lanes).includes("postgres-auth"));
    assert.equal(needs["postgres-auth"], undefined);
    assert.ok(array(record(needs["image-lanes-same-sha"]).lanes).includes("images-packaging"));
  }
  const withoutPlan = await execute("success", ["postgres"], "failure", "");
  assert.equal(withoutPlan.postgres, undefined);
  assert.ok(array(record(withoutPlan["pr-safe-same-sha"]).lanes).includes("postgres"));
  assert.equal(record(withoutPlan["pr-safe-same-sha"]).result, "failure");
  // Even when every eligible lane is reused, the two fresh-only lanes retain
  // the real parent outcome. Reused lanes must not also belong to that parent.
  const { rows, sha } = await reuseFixture();
  const allReused = await execute(
    "success",
    rows.map((row) => row.lane),
  );
  assert.deepEqual(allReused["pr-safe-same-sha"], {
    result: "failure",
    lanes: ["k3d-observability-demo", "repository-credentials-container"],
  });
  for (const { lane } of rows) {
    assert.deepEqual(allReused[lane], { result: "success" });
  }

  // Feed the shipped workflow's output into the real aggregator with receipts
  // made by its runner. This proves mixed direct/matrix ownership, not merely
  // the shape of needs.json; these tiny cases do not exercise PostgreSQL.
  const lanes = ["postgres", "postgres-auth"];
  await mkdir(join(directory, "tests/integration"), { recursive: true });
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({
      version: 1,
      lanes: Object.fromEntries(
        lanes.map((lane) => [
          lane,
          {
            files: [{ path: `tests/integration/${lane}.test.mjs`, expectedTests: [lane] }],
          },
        ]),
      ),
      groups: { ci: lanes },
    }),
  );
  const runner = (args: string[]) =>
    spawnSync(
      process.execPath,
      ["scripts/ci/run-tests.ts", ...args, "--root", directory, "--manifest", "manifest.json"],
      {
        encoding: "utf8",
        env: { ...process.env, GITHUB_SHA: sha, GIT_CEILING_DIRECTORIES: directory },
      },
    );
  for (const lane of lanes) {
    await writeFile(
      join(directory, `tests/integration/${lane}.test.mjs`),
      `import test from "node:test"; test(${JSON.stringify(lane)}, () => {});\n`,
    );
    const result = runner([
      "run",
      lane,
      "--state",
      `state/${lane}.json`,
      "--results",
      `results/${lane}.json`,
    ]);
    assert.equal(result.status, 0, result.stderr);
  }
  // The retry action owns a separate directory. Combine its completed download
  // with a fresh runner receipt without deleting the fresh evidence.
  await mkdir(join(directory, "reused-results"));
  const retainedReceipt = await readFile(join(directory, "results/postgres.json"));
  const freshReceipt = await readFile(join(directory, "results/postgres-auth.json"));
  await writeFile(join(directory, "reused-results/postgres.json"), retainedReceipt);
  await rm(join(directory, "results/postgres.json"));
  const combined = spawnSync("bash", ["-e", "-c", text(present(combine).run)], {
    encoding: "utf8",
    env: { ...process.env, RUNNER_TEMP: directory },
  });
  assert.equal(combined.status, 0, combined.stderr);
  assert.deepEqual(await readFile(join(directory, "results/postgres.json")), retainedReceipt);
  assert.deepEqual(await readFile(join(directory, "results/postgres-auth.json")), freshReceipt);
  const aggregate = () =>
    runner(["aggregate", "ci", "--results-dir", "results", "--needs", "needs.json"]);
  await execute("success");
  const failed = aggregate();
  assert.equal(failed.status, 1, failed.stderr);
  const summary = jsonRecord(failed.stdout);
  assert.deepEqual(
    array(summary.issues)
      .map(record)
      .map(({ code, need }) => ({ code, need })),
    [{ code: "need-not-success", need: "pr-safe-same-sha" }],
  );
  assert.ok(array(summary.lanes).every((lane) => record(lane).status === "passed"));
  await execute(
    "success",
    rows.map((row) => row.lane),
  );
  assert.deepEqual(
    summaryIssues(aggregate().stdout).map((issue) => issue.code),
    ["need-not-success"],
  );
  await execute(
    "success",
    rows.map((row) => row.lane),
    "success",
  );
  assert.equal(aggregate().status, 0);
  // A success entry cannot replace the reused lane's missing or stale receipt.
  const receipt = join(directory, "results/postgres.json");
  const original = await readFile(receipt, "utf8");
  await writeFile(receipt, JSON.stringify({ ...jsonRecord(original), sourceSha: "0".repeat(40) }));
  assert.ok(
    summaryIssues(aggregate().stdout).some((issue) => issue.code === "source-sha-mismatch"),
  );
  await rm(receipt);
  assert.ok(
    summaryIssues(aggregate().stdout).some((issue) => issue.code === "missing-lane-output"),
  );
}
