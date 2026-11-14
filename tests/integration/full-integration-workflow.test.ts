import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { validateFullIntegrationPreflight } from "../../scripts/ci/full-integration-preflight.ts";
import { selectQaMatrix } from "../helpers/qa-selection.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

import { mainRun } from "./full-integration-approval-fixture.ts";
import { array, jsonRecord, present, record, text } from "./full-integration-json-fixture.ts";
import { reuseFixture } from "./full-integration-reuse-fixture.ts";
import {
  parseWorkflow,
  readLaneAction,
  readWorkflow,
} from "./full-integration-workflow-fixture.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

function jobStateProgram(workflow: string) {
  const step = present(workflow.split("- name: Write selected job state")[1]);
  return present(step.match(/node <<'NODE'\n([\s\S]*?)\n\s+NODE/)?.[1]);
}

function summaryIssues(stdout: string) {
  return array(jsonRecord(stdout).issues).map(record);
}

test("full integration workflow carries QA and installation outcomes into selected aggregation", async (t) => {
  const directory = await temporaryDirectory(t, "qa-aggregate-");
  const workflow = await readFile(
    new URL("../../.github/workflows/full-integration-execution.yml", import.meta.url),
    "utf8",
  );
  const source = jobStateProgram(workflow);
  for (const target of ["qa-matrix", "dev-up-k3d", "skipper-prepared-git-installed"]) {
    for (const lane of [target, "all"]) {
      for (const result of ["success", "failure", "cancelled", "skipped", "missing"]) {
        const needs: Record<string, { result: string }> = { preflight: { result: "success" } };
        if (result !== "missing") {
          needs[target] = { result };
        }
        // Execute the shipped workflow step: every selected lane must reach
        // aggregate validation, including failures and absent job outcomes.
        const process = spawnSync(globalThis.process.execPath, ["--input-type=commonjs"], {
          input: source,
          encoding: "utf8",
          env: { RUNNER_TEMP: directory, NEEDS_JSON: JSON.stringify(needs), SELECTED_LANE: lane },
        });
        assert.equal(process.status, 0, process.stderr);
        const recorded = jsonRecord(await readFile(join(directory, "needs.json"), "utf8"));
        assert.deepEqual(recorded[target], { result }, `${lane}: ${target}: ${result}`);
      }
    }
  }
  const aggregateJob = present(parseWorkflow(workflow).jobs["full-aggregate"]);
  const aggregate = present(aggregateJob.steps).find(
    (item) => item.name === "Aggregate targeted runtime results",
  );
  // A rejected reusable-workflow string still reaches failure aggregation.
  // It must remain data even when it contains shell command substitution.
  const context = {
    needs: { preflight: { result: "failure", outputs: { selected_lane: "" } } },
    inputs: { lane: '$(touch "$RUNNER_TEMP/rejected-lane-command")' },
  };
  await assert.rejects(
    validateFullIntegrationPreflight({
      env: {
        ...mainRun,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        INPUT_LANE: context.inputs.lane,
      },
    }),
    /Unknown lane/,
  );
  const requireSelection = present(aggregateJob.steps).find(
    (item) => item.name === "Require validated selection",
  );
  assert.equal(workflowCondition(present(requireSelection).if, context), true);
  const refusal = spawnSync("/bin/sh", ["-c", text(present(requireSelection).run)], {
    env: {},
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(refusal.error, undefined);
  assert.equal(refusal.status, 1, refusal.stderr);
  assert.match(refusal.stdout, /Preflight did not provide a validated selection/);
  // Independently keep the shell boundary safe even if an invalid string is
  // supplied as the selected value; validation must not be its only defense.
  context.needs.preflight.outputs.selected_lane = context.inputs.lane;
  const result = spawnSync(
    "/bin/sh",
    [
      "-c",
      text(present(aggregate).run).replace(/\$\{\{.*?\}\}/g, (expression) =>
        text(workflowCondition(expression, context)),
      ),
    ],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: {
        PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
        RUNNER_TEMP: directory,
        ...Object.fromEntries(
          Object.entries(present(aggregate).env ?? {}).map(([name, expression]) => [
            name,
            text(workflowCondition(expression, context)),
          ]),
        ),
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, "The unknown lane must fail aggregation");
  await assert.rejects(stat(join(directory, "rejected-lane-command")), { code: "ENOENT" });
});

test("full integration plans fresh fallback and attributes only published reuse to successful needs", async (t) => {
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
      ["scripts/ci/run-tests.mjs", ...args, "--root", directory, "--manifest", "manifest.json"],
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
});

test("split dispatcher leaves skipped ticks outside the execution queue", async () => {
  const dispatcher = await readWorkflow("full-integration");
  // A workflow-level lock would let an ineligible tick replace pending full work
  // before the selector runs. Only the eligible reusable-workflow call may lock.
  assert.equal(dispatcher.concurrency, undefined);
  const execution = await readWorkflow("full-integration-execution");
  const execute = present(dispatcher.jobs.execute);
  assert.equal(execution.concurrency, undefined);
  assert.deepEqual(
    new Set(Object.keys(dispatcher.jobs)),
    new Set(["manual-approval", "preflight", "execute", "reject-selection"]),
  );
  assert.equal(present(dispatcher.jobs.preflight).concurrency, undefined);
  assert.equal(present(dispatcher.jobs["manual-approval"]).concurrency, undefined);
  assert.equal(execute.needs, "preflight");
  assert.equal(execute.uses, "./.github/workflows/full-integration-execution.yml");
  assert.deepEqual(execution.on, {
    workflow_call: { inputs: { lane: { type: "string", default: "" } } },
  });
  assert.equal(record(execute.with).lane, "${{ inputs.lane || '' }}");
  assert.equal(execute.secrets, "inherit");
  assert.deepEqual(execution.permissions, dispatcher.permissions);
  assert.deepEqual(execution.env, dispatcher.env);
  const preflightSteps = (workflow: ReturnType<typeof parseWorkflow>) =>
    present(present(workflow.jobs.preflight).steps);
  const selectStep = (workflow: ReturnType<typeof parseWorkflow>) =>
    present(preflightSteps(workflow).find((step) => step.id === "select"));
  // Both event types execute this TypeScript command using the pinned Node setup.
  for (const workflow of [dispatcher, execution]) {
    const steps = preflightSteps(workflow);
    const setup = present(steps.find((step) => step.uses?.startsWith("actions/setup-node@")));
    assert.equal(setup.if, undefined);
    assert.equal(record(setup.with)["node-version"], "${{ env.NODE_VERSION }}");
    assert.match(text(record(workflow.env).NODE_VERSION), /^24\./);
    assert.ok(steps.indexOf(setup) < steps.indexOf(selectStep(workflow)));
  }
  assert.equal(
    text(selectStep(dispatcher).run).trim(),
    "node scripts/ci/full-integration-preflight.ts",
  );
  assert.deepEqual(selectStep(execution), selectStep(dispatcher));
  assert.ok(!JSON.stringify(dispatcher).includes("full-integration-admitted"));
  assert.ok(
    present(present(execution.jobs.preflight).steps).some(
      (step) => step.with?.name === "full-integration-admitted-v1",
    ),
  );

  const github = {
    repository: mainRun.GITHUB_REPOSITORY,
    ref: mainRun.GITHUB_REF,
    ref_type: "branch",
    event_name: "schedule",
    run_attempt: "1",
  };
  for (const [file, workflow] of Object.entries({ dispatcher, execution })) {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      assert.ok(job.if, "every Full Integration job has an explicit selection condition");
      assert.equal(
        workflowCondition(job.if, {
          github,
          needs: {
            preflight: { result: "success", outputs: { selected_lane: "skip", run_all: "false" } },
            "manual-approval": { result: "skipped" },
            "runtime-artifact": { result: "skipped" },
            "gateway-image-selection": { result: "skipped", outputs: {} },
            slack: { result: "skipped" },
          },
          inputs: {},
          always: () => true,
        }),
        name === "preflight",
        `skipped tick: ${file}/${name}`,
      );
    }
  }
  for (const selectedLane of ["all", "skip"]) {
    const preflight = {
      result: "success",
      outputs: { selected_lane: selectedLane, run_all: String(selectedLane === "all") },
    };
    assert.equal(
      workflowCondition(execute.if, { github, needs: { preflight } }),
      selectedLane === "all",
    );
    assert.equal(
      workflowCondition(execute.if, { github, needs: { preflight }, cancelled: () => true }),
      false,
    );
  }
  const reject = present(dispatcher.jobs["reject-selection"]);
  assert.deepEqual(reject.permissions, {});
  assert.doesNotMatch(JSON.stringify(reject), /secrets\.|actions\/checkout/);
  // Model completed-job output loss or inconsistency. A valid skipped tick
  // succeeds without the lock; every invalid decision reports failure outside it.
  for (const eventName of ["schedule", "workflow_dispatch"]) {
    for (const selectedLane of ["", "unknown-lane", "docs", "skip", "all", "gateway-routing"]) {
      const context = {
        github: { ...github, event_name: eventName },
        inputs: { lane: "gateway-routing" },
        needs: { preflight: { result: "success", outputs: { selected_lane: selectedLane } } },
      };
      const admitted =
        eventName === "schedule" ? selectedLane === "all" : selectedLane === "gateway-routing";
      const skippedTick = eventName === "schedule" && selectedLane === "skip";
      assert.equal(
        workflowCondition(execute.if, context),
        admitted,
        `${eventName}: ${selectedLane}`,
      );
      assert.equal(
        workflowCondition(reject.if, context),
        !admitted && !skippedTick,
        `${eventName}: ${selectedLane}`,
      );
      if (!admitted && !skippedTick) {
        const result = spawnSync("/bin/sh", ["-c", text(present(present(reject.steps)[0]).run)], {
          encoding: "utf8",
          timeout: 30_000,
          env: {},
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stdout, /Preflight did not publish a matching supported lane/);
      }
    }
  }
  const manualDocs = {
    github: { ...github, event_name: "workflow_dispatch" },
    inputs: { lane: "docs" },
    needs: { preflight: { result: "success", outputs: { selected_lane: "docs" } } },
  };
  assert.equal(workflowCondition(execute.if, manualDocs), false);
  assert.equal(workflowCondition(reject.if, manualDocs), true);
});

function workflowCondition(expression: unknown, context: Record<string, unknown>): unknown {
  return runInNewContext(
    text(expression)
      .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
      .replace(/\b(needs|steps)\.([a-z][a-z0-9-]*)/g, '$1["$2"]')
      .replace(/\.outputs\.([a-z][a-z0-9_-]*)/g, '.outputs["$1"]')
      .replace(/\.([a-z][a-z0-9]*-[a-z0-9-]+)/g, '["$1"]'),
    { cancelled: () => false, ...context },
  );
}

test("OpenShell waits for its protected-input warm export before source builds", async (t) => {
  const execution = await readWorkflow("full-integration-execution");
  const warmer = await readWorkflow("ci-image-cache");
  const inputs = present(execution.jobs["openshell-build-inputs"]);
  const producer = present(execution.jobs["openshell-image-cache"]);
  const consumer = present(execution.jobs.openshell);
  assert.equal(inputs.environment, "integration-main");
  assert.deepEqual(inputs.permissions, {});
  const inputStep = present(inputs.steps).find((step) => step.id === "inputs");
  assert.equal(
    record(present(inputStep).env).NODE_BASE_IMAGE,
    "${{ vars.CONTAINER_NODE_BASE_IMAGE }}",
  );
  assert.equal(
    record(inputs.outputs)["node-base-image"],
    "${{ steps.inputs.outputs.node-base-image }}",
  );
  assert.equal(producer.uses, "./.github/workflows/ci-image-cache.yml");
  assert.equal(record(producer.with)["require-export"], true);
  assert.equal(record(producer.with)["node-base-image"], record(consumer.env).NODE_BASE_IMAGE);
  assert.equal(
    record(producer.with)["node-base-image"],
    record(consumer.env).OCC_DEVELOPMENT_NODE_BASE_IMAGE,
  );
  assert.ok(present(producer.needs).includes("openshell-build-inputs"));
  assert.ok(present(consumer.needs).includes("openshell-image-cache"));
  assert.ok(present(consumer.needs).includes("openshell-build-inputs"));
  assert.equal(record(warmer.concurrency).group, "ci-image-cache-${{ github.ref }}");
  assert.equal(record(warmer.concurrency).queue, "max");
  assert.equal(record(warmer.concurrency)["cancel-in-progress"], false);
  assert.equal(
    record(record(record(warmer.on.workflow_call).inputs)["require-export"]).default,
    false,
  );
  const github = {
    repository: mainRun.GITHUB_REPOSITORY,
    ref: mainRun.GITHUB_REF,
    ref_type: "branch",
    run_attempt: "1",
    event_name: "workflow_dispatch",
    sha: "a".repeat(40),
  };
  for (const selection of ["all", "openshell", "gateway-routing", "skip"]) {
    const needs = {
      preflight: { result: "success", outputs: { selected_lane: selection } },
      "openshell-build-inputs": {
        result: "success",
        outputs: {
          "node-base-image": `docker.io/library/node:24-bookworm@sha256:${"a".repeat(64)}`,
        },
      },
      "openshell-image-cache": { result: "success", outputs: { "source-sha": github.sha } },
    };
    const selectedBase = needs["openshell-build-inputs"].outputs["node-base-image"];
    assert.equal(
      workflowCondition(record(producer.with)["node-base-image"], { needs }),
      selectedBase,
    );
    assert.equal(workflowCondition(record(consumer.env).NODE_BASE_IMAGE, { needs }), selectedBase);
    assert.equal(
      workflowCondition(record(consumer.env).OCC_DEVELOPMENT_NODE_BASE_IMAGE, { needs }),
      selectedBase,
    );
    const selected = ["all", "openshell"].includes(selection);
    for (const job of [inputs, producer, consumer]) {
      assert.equal(workflowCondition(job.if, { github, needs }), selected);
    }
    for (const result of ["failure", "cancelled", "skipped"]) {
      needs["openshell-image-cache"].result = result;
      assert.equal(workflowCondition(consumer.if, { github, needs }), false);
    }
    needs["openshell-image-cache"] = {
      result: "success",
      outputs: { "source-sha": "b".repeat(40) },
    };
    assert.equal(workflowCondition(consumer.if, { github, needs }), false);
    needs["openshell-build-inputs"].result = "failure";
    assert.equal(workflowCondition(producer.if, { github, needs }), false);
  }
  // The actual resolver must not publish a missing or multiline environment value.
  const dir = await temporaryDirectory(t, "openshell-warm-inputs-");
  const output = join(dir, "output");
  const script = text(present(inputStep).run);
  for (const value of ["", "image\nother=value", "image\rother=value"]) {
    const result = spawnSync("bash", ["-e", "-c", script], {
      env: { PATH: process.env.PATH, NODE_BASE_IMAGE: value, GITHUB_OUTPUT: output },
    });
    assert.notEqual(result.status, 0);
  }
  assert.equal(
    spawnSync("bash", ["-e", "-c", script], {
      env: { PATH: process.env.PATH, NODE_BASE_IMAGE: "protected-base", GITHUB_OUTPUT: output },
    }).status,
    0,
  );
  assert.equal(await readFile(output, "utf8"), "node-base-image=protected-base\n");
});

test("workflow gates scheduled and approved manual attempts before starting lanes", async () => {
  const workflow = await readWorkflow("full-integration");
  assert.equal(workflow.on.push, undefined);
  assert.equal(array(workflow.on.schedule).length, 1);
  assert.equal(workflow.on.pull_request, undefined);
  const execution = await readWorkflow("full-integration-execution");
  const jobs = [...Object.entries(workflow.jobs), ...Object.entries(execution.jobs)].filter(
    ([name]) =>
      !["manual-approval", "preflight", "full-aggregate", "reject-selection"].includes(name),
  );
  assert.ok(jobs.length > 0);
  for (const [name, job] of jobs) {
    for (const event_name of ["schedule", "workflow_dispatch"]) {
      const github = {
        sha: "a".repeat(40),
        repository: mainRun.GITHUB_REPOSITORY,
        ref: mainRun.GITHUB_REF,
        ref_type: "branch",
        run_attempt: "1",
        event_name,
      };
      const needs = {
        preflight: {
          result: "success",
          outputs: {
            selected_lane:
              name === "logging-collector" && event_name === "workflow_dispatch" ? name : "all",
            run_all: "true",
          },
        },
        slack: { result: "success" },
        "runtime-artifact": { result: "success" },
        "openshell-build-inputs": { result: "success" },
        "openshell-image-cache": { result: "success", outputs: { "source-sha": "a".repeat(40) } },
        "gateway-image-selection": {
          result: "success",
          outputs: { "use-runtime-artifact": "true" },
        },
      };
      const inputs = { lane: needs.preflight.outputs.selected_lane };
      assert.equal(
        workflowCondition(job.if, { github, needs, inputs }),
        event_name !== "schedule" || name !== "logging-collector",
        `\${name}: first attempt`,
      );
      assert.equal(
        workflowCondition(job.if, {
          github,
          inputs,
          needs: {
            ...needs,
            preflight: { result: "success", outputs: { selected_lane: "skip", run_all: "false" } },
          },
        }),
        false,
        `\${name}: skipped admission`,
      );
      assert.equal(
        workflowCondition(job.if, { github: { ...github, run_attempt: "2" }, needs, inputs }),
        false,
        `\${name}: use a new approved dispatch to retry`,
      );
      for (const patch of [
        { ref: "refs/tags/main", ref_type: "tag" },
        { repository: "other/repository" },
        { event_name: "pull_request" },
      ]) {
        assert.equal(
          workflowCondition(job.if, { github: { ...github, ...patch }, needs, inputs }),
          false,
          `${name}: ${JSON.stringify(patch)}`,
        );
      }
      assert.equal(
        workflowCondition(job.if, {
          github,
          needs: { ...needs, preflight: { result: "failure", outputs: { selected_lane: "all" } } },
        }),
        false,
        `${name}: failed preflight`,
      );
    }
  }
  const scheduled = {
    repository: mainRun.GITHUB_REPOSITORY,
    ref: mainRun.GITHUB_REF,
    ref_type: "branch",
    event_name: "schedule",
    run_id: "7",
    run_attempt: "1",
  };
  const group = (github: typeof scheduled, lane: string) =>
    workflowCondition(record(present(execution.jobs.preflight).concurrency).group, {
      github,
      inputs: { lane },
      format: (template: string, value: string) => template.replace("{0}", value),
    });
  const approved = { ...scheduled, event_name: "workflow_dispatch", run_id: "9" };
  assert.equal(group(scheduled, ""), group(approved, "all"));
  assert.notEqual(group(scheduled, ""), group(approved, "docker-model"));
  assert.equal(record(present(execution.jobs.preflight).concurrency).queue, "max");
  const receiptGate = present(present(execution.jobs.preflight).steps).find(
    (step) => step.name === "Require scheduled admission receipt",
  );
  assert.ok(receiptGate);
  for (const outcome of ["failure", "skipped", "success"]) {
    assert.equal(
      workflowCondition(receiptGate.if, {
        github: scheduled,
        steps: {
          select: { outputs: { run_all: "true" } },
          "confirm-admission-marker": { outcome },
        },
      }),
      outcome !== "success",
    );
  }
  const aggregate = present(execution.jobs["full-aggregate"]);
  assert.equal(
    workflowCondition(aggregate.if, {
      github: scheduled,
      needs: { preflight: { result: "success", outputs: { selected_lane: "skip" } } },
      always: () => true,
    }),
    false,
  );
  const manual = present(workflow.jobs["manual-approval"]);
  assert.equal(manual.environment, "integration-main-approval");
  assert.deepEqual(manual.permissions, {});
  assert.doesNotMatch(JSON.stringify(manual), /secrets\.|actions\/checkout/);
  const github = {
    repository: mainRun.GITHUB_REPOSITORY,
    ref: mainRun.GITHUB_REF,
    ref_type: "branch",
    run_attempt: "1",
    event_name: "schedule",
  };
  assert.equal(
    workflowCondition(present(workflow.jobs.preflight).if, {
      github,
      needs: { "manual-approval": { result: "skipped" } },
    }),
    true,
  );
  for (const event_name of ["schedule", "workflow_dispatch"]) {
    assert.equal(
      workflowCondition(present(workflow.jobs.preflight).if, {
        github: { ...github, event_name, run_attempt: "2" },
        needs: { "manual-approval": { result: "skipped" } },
      }),
      true,
      "Retries reach preflight so refused manual reruns cannot silently skip every job",
    );
  }
  assert.equal(
    workflowCondition(manual.if, {
      github: { ...github, event_name: "workflow_dispatch", run_attempt: "2" },
    }),
    false,
  );
  // Run the shipped preflight command: manual retries must report failure while
  // the approval and expensive execution jobs remain excluded above.
  const select = present(present(workflow.jobs.preflight).steps).find(
    (step) => step.id === "select",
  );
  const refused = spawnSync("/bin/sh", ["-c", text(present(select).run)], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: {
      ...mainRun,
      PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_RUN_ATTEMPT: "2",
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(refused.error, undefined);
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /Manual integration reruns are refused/);
  for (const result of ["skipped", "failure", "cancelled", "success"]) {
    assert.equal(
      workflowCondition(present(workflow.jobs.preflight).if, {
        github: { ...github, event_name: "workflow_dispatch" },
        needs: { "manual-approval": { result } },
      }),
      result === "success",
    );
  }
});

test("manual dev-up workflow prepares the complete lane and aggregates its exact source", async (t) => {
  const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
  const dispatcher = await readWorkflow("full-integration");
  const workflow = await readWorkflow("full-integration-execution");
  const actionSteps = await readLaneAction();
  const finalCleanup = actionSteps.find((step) => step.id === "cleanup-lane");
  assert.equal(present(finalCleanup).if, "always()");
  assert.equal(
    present(finalCleanup).run,
    'node scripts/ci/cleanup.ts --state "$RUNNER_TEMP/state/${{ inputs.lane }}.json" --results "$RUNNER_TEMP/results/${{ inputs.lane }}.json"',
  );
  const groups = record(jsonRecord(await read("scripts/ci/test-suites.json")).groups);
  assert.ok(
    array(record(record(record(dispatcher.on.workflow_dispatch).inputs).lane).options).includes(
      "dev-up-k3d",
    ),
  );
  assert.equal(dispatcher.on.push, undefined);
  assert.equal(array(dispatcher.on.schedule).length, 1);
  assert.equal(dispatcher.on.pull_request, undefined);
  assert.equal(dispatcher.on.pull_request_target, undefined);
  assert.equal(record(record(dispatcher.on.workflow_dispatch).inputs).source_ref, undefined);
  for (const selected of [...Object.values(dispatcher.jobs), ...Object.values(workflow.jobs)]) {
    for (const step of selected.steps ?? []) {
      if (step.uses?.startsWith("actions/checkout@")) {
        assert.equal(record(step.with).ref, "${{ github.sha }}");
        assert.equal(record(step.with)["persist-credentials"], false);
      }
    }
  }
  // A pending manual approval cannot occupy the automatic queue or replace another
  // pending approval, even if both dispatchers select the same lane.
  const queue = (eventName: string, runId: string) =>
    workflowCondition(record(present(dispatcher.jobs.execute).concurrency).group, {
      github: { event_name: eventName, run_id: runId },
      format: (template: string, value: string) => template.replace("{0}", value),
    });
  assert.equal(record(present(dispatcher.jobs.execute).concurrency)["cancel-in-progress"], false);
  const automaticQueue = queue("schedule", "100");
  const manualQueue = queue("workflow_dispatch", "101");
  assert.equal(automaticQueue, queue("schedule", "102"));
  assert.notEqual(automaticQueue, manualQueue);
  assert.notEqual(manualQueue, queue("workflow_dispatch", "103"));

  // Both event types acquire the same resource lock only after authorization.
  const queuedLanes = ["slack", "dev-up-k3d", "skipper-prepared-git-installed"];
  assert.equal(record(present(dispatcher.jobs.execute).concurrency).queue, undefined);
  const jobsWithQueue = Object.entries(workflow.jobs)
    .filter(([, job]) => typeof job.concurrency === "object" && job.concurrency.queue !== undefined)
    .map(([lane]) => lane);
  assert.deepEqual(jobsWithQueue.sort(), ["preflight", ...queuedLanes].sort());
  const resourceQueues = new Set<string>();
  for (const lane of queuedLanes) {
    const job = present(workflow.jobs[lane]);
    assert.equal(job.needs, "preflight");
    assert.equal(record(job.concurrency)["cancel-in-progress"], false);
    assert.equal(record(job.concurrency).queue, "max");
    const group = text(record(job.concurrency).group);
    assert.ok(group.startsWith("full-integration-"));
    if (lane === "slack") {
      assert.doesNotMatch(group, /\$\{/);
    } else {
      assert.equal(group, ["full-integration", lane, "${{ github.ref }}"].join("-"));
    }
    assert.ok(!resourceQueues.has(group));
    resourceQueues.add(group);
  }
  // Exercise the hosted workflow input through the same selector that determines
  // which credentials to materialize and which real installation cells run.
  const qaJob = present(workflow.jobs["qa-matrix"]);
  const qaManifest = jsonRecord(await read("scripts/ci/test-suites/qa-matrix.json"));
  const qaRunnerEnv = Object.fromEntries(
    Object.entries(present(qaJob.env))
      .filter(([name]) => array(qaManifest.optionalEnv).includes(name))
      .map(([name, value]) => [name, text(value)]),
  );
  const qaSelection = selectQaMatrix(qaRunnerEnv);
  assert.equal(qaSelection.scope, "partial:selected");
  assert.deepEqual(qaSelection.installations, ["compose", "kubernetes"]);
  assert.deepEqual(
    qaSelection.cells.map(({ cell, scenarios }) => ({ cell, scenarios })),
    [
      { cell: "compose/OpenClaw", scenarios: ["model-ui", "console-secrets"] },
      { cell: "compose/Codex", scenarios: ["console-secrets", "agent-audit"] },
      { cell: "kubernetes/OpenClaw", scenarios: ["model-ui", "console-secrets"] },
      { cell: "kubernetes/Codex", scenarios: ["console-secrets"] },
    ],
  );
  assert.equal(qaSelection.exclusions.length, 2);
  assert.deepEqual(qaSelection.requiredEnv, [
    "OCC_TEST_QA_OPENAI_KEY_FILE",
    "OCC_TEST_QA_CODEX_TOKEN_FILE",
  ]);
  assert.deepEqual(
    Object.keys(
      record(
        present(
          present(qaJob.steps).find(({ name }) => name === "Materialize selected QA credentials"),
        ).env,
      ),
    ).sort(),
    ["CODEX_ACCESS_TOKEN", "OPENAI_API_KEY"],
  );
  const job = present(workflow.jobs["dev-up-k3d"]);
  assert.equal(job.environment, undefined);
  assert.deepEqual(job.env, {
    NODE_BASE_IMAGE: "${{ vars.CONTAINER_NODE_BASE_IMAGE }}",
  });
  assert.equal(job.needs, "preflight");
  assert.equal(job["runs-on"], "ubuntu-22.04");
  for (const lane of ["dev-up-k3d", "all", "k3d-model"]) {
    assert.equal(
      workflowCondition(job.if, {
        github: {
          repository: mainRun.GITHUB_REPOSITORY,
          ref: mainRun.GITHUB_REF,
          ref_type: "branch",
          run_attempt: "1",
          event_name: "workflow_dispatch",
        },
        needs: { preflight: { result: "success", outputs: { selected_lane: lane } } },
      }),
      lane === "dev-up-k3d" || lane === "all",
    );
  }
  const checkout = record(present(present(job.steps)[0]).with);
  assert.equal(checkout.ref, "${{ github.sha }}");
  assert.equal(checkout["persist-credentials"], false);
  const run = present(job.steps).find(({ uses }) => uses === "./.github/actions/run-ci-lane");
  assert.equal(record(present(run).with).lane, "dev-up-k3d");
  assert.equal(record(present(run).with).profile, "full");
  assert.equal(record(present(run).with)["artifact-prefix"], "full-results");
  assert.ok(present(workflow.jobs["full-aggregate"]).needs?.includes("dev-up-k3d"));
  assert.equal(array(groups.ci).includes("dev-up-k3d"), false);
  for (const lane of array(
    record(record(record(dispatcher.on.workflow_dispatch).inputs).lane).options,
  )) {
    if (lane !== "all") {
      assert.ok(array(groups.full).includes(lane), `all must require ${lane} results`);
    }
  }
  const privateGit = "skipper-prepared-git-installed";
  const gitJob = present(workflow.jobs[privateGit]);
  assert.equal(gitJob.environment, undefined);
  assert.deepEqual(gitJob.permissions, { contents: "read" });
  assert.equal(gitJob.needs, "preflight");
  assert.equal(gitJob["runs-on"], "ubuntu-22.04");
  for (const lane of [privateGit, "all", "dev-up-k3d"]) {
    assert.equal(
      workflowCondition(gitJob.if, {
        github: {
          repository: mainRun.GITHUB_REPOSITORY,
          ref: mainRun.GITHUB_REF,
          ref_type: "branch",
          run_attempt: "1",
          event_name: "workflow_dispatch",
        },
        needs: { preflight: { result: "success", outputs: { selected_lane: lane } } },
      }),
      [privateGit, "all"].includes(lane),
    );
  }
  const gitCheckout = record(present(present(gitJob.steps)[0]).with);
  assert.equal(gitCheckout.ref, "${{ github.sha }}");
  assert.equal(gitCheckout["persist-credentials"], false);
  assert.doesNotMatch(JSON.stringify(gitJob), /secrets\.|diagnostics\//);
  const uploads = present(gitJob.steps).filter(({ uses }) =>
    uses?.startsWith("actions/upload-artifact@"),
  );
  const receipt = uploads.find((step) => step.with?.name === "full-results-" + privateGit);
  assert.equal(
    record(present(receipt).with).path,
    "${{ runner.temp }}/results/" + privateGit + ".json",
  );
  assert.equal(
    present(receipt).if,
    undefined,
    "publish the receipt only after successful fixture cleanup",
  );
  const failure = uploads.find(
    (step) => step.with?.name === "attempt-${{ github.run_attempt }}-full-failure-" + privateGit,
  );
  assert.equal(
    record(present(failure).with).path,
    "${{ runner.temp }}/skipper-installed-failure.json",
  );
  assert.equal(record(present(failure).with)["if-no-files-found"], "error");
  const proof = present(gitJob.steps).find((step) => step.id === "installed-skipper-proof");
  assert.ok(
    text(present(proof).run).includes(
      "node scripts/qualification/skipper-private-git-fixture.mjs --team-review -- node scripts/ci/skipper-prepared-git-installed.mjs",
    ),
  );
  const recordFailure = present(gitJob.steps).find(
    (step) => step.id === "installed-skipper-failure",
  );
  // Failure evidence stays separate from success aggregation and is withheld on cancellation.
  for (const [proofOutcome, recorderOutcome] of [
    ["failure", "success"],
    ["failure", "failure"],
    ["success", "skipped"],
    ["skipped", "skipped"],
  ]) {
    for (const cancelled of [false, true]) {
      const steps: Record<string, { outcome: string | undefined }> = {
        "installed-skipper-proof": { outcome: proofOutcome },
      };
      const context = { cancelled: () => cancelled, steps };
      assert.equal(
        workflowCondition(present(recordFailure).if, context),
        !cancelled && proofOutcome === "failure",
      );
      context.steps["installed-skipper-failure"] = { outcome: recorderOutcome };
      assert.equal(
        workflowCondition(present(failure).if, context),
        !cancelled && recorderOutcome === "success",
      );
    }
  }
  assert.ok(present(workflow.jobs["full-aggregate"]).needs?.includes(privateGit));
  const qa = present(workflow.jobs["qa-matrix"]);
  assert.ok(present(qa.needs).includes("slack"), "shared Slack consumers must run sequentially");
  // A failed focused Slack proof must not suppress the broader QA proof. Only
  // failed preflight, an unselected lane, or run cancellation should prevent it.
  for (const lane of ["all", "qa-matrix", "docker-model"]) {
    for (const preflight of ["success", "failure"]) {
      for (const slack of ["success", "failure", "skipped"]) {
        for (const cancelled of [false, true]) {
          const selected: unknown = runInNewContext(
            text(qa.if).replace(/^\$\{\{\s*|\s*\}\}$/g, ""),
            {
              inputs: { lane },
              github: {
                repository: mainRun.GITHUB_REPOSITORY,
                ref: mainRun.GITHUB_REF,
                ref_type: "branch",
                run_attempt: "1",
                event_name: "workflow_dispatch",
              },
              needs: {
                preflight: { result: preflight, outputs: { selected_lane: lane } },
                slack: { result: slack },
              },
              always: () => true,
              cancelled: () => cancelled,
            },
          );
          assert.equal(
            selected,
            !cancelled && preflight === "success" && ["all", "qa-matrix"].includes(lane),
            `${lane}: preflight ${preflight}, slack ${slack}, cancelled ${cancelled}`,
          );
        }
      }
    }
  }
  const inputs = { lane: "dev-up-k3d", profile: record(present(run).with).profile };
  const directory = await temporaryDirectory(t, "manual-dev-up-image-mode-");
  const output = join(directory, "outputs");
  const mode = actionSteps.find(({ id }) => id === "image-mode");
  const imageSelection = spawnSync("bash", ["-c", text(present(mode).run)], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CI_SELECTED_LANE: inputs.lane,
      CI_SELECTED_TEST_FILE: "",
      GITHUB_OUTPUT: output,
    },
  });
  assert.equal(imageSelection.status, 0, imageSelection.stderr);
  const firstAgent = /^first-agent=(true|false)$/m.exec(await readFile(output, "utf8"))?.[1];
  assert.ok(firstAgent, "the shipped image selection must publish its mode");
  const sourceBuild = /^source-build=(true|false)$/m.exec(await readFile(output, "utf8"))?.[1];
  assert.ok(sourceBuild);
  const evaluate = (expression: unknown): unknown =>
    runInNewContext(
      text(expression)
        .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
        // GitHub property names may contain hyphens; JavaScript needs brackets.
        .replaceAll(
          "steps.image-mode.outputs.first-agent",
          'steps["image-mode"].outputs["first-agent"]',
        )
        .replaceAll(
          "steps.image-mode.outputs.source-build",
          'steps["image-mode"].outputs["source-build"]',
        ),
      {
        inputs,
        steps: {
          "image-mode": { outputs: { "first-agent": firstAgent, "source-build": sourceBuild } },
        },
        startsWith: (value: string, prefix: string) => value.startsWith(prefix),
      },
    );
  for (const name of [
    "Set up Go toolchain",
    "Build Go CLI for development installation proof",
    "Install browser dependencies",
    "Enable Kubernetes bridge packet filtering",
    // certutil imports the printed CA files into the Keycloak case's browser.
    "Install trusted browser certificate tooling",
  ]) {
    const step = actionSteps.find((step) => step.name === name);
    assert.equal(evaluate(present(step).if), true, `${name} must run for this lane`);
  }
  const timeout = Number(
    evaluate(
      record(present(actionSteps.find(({ name }) => name === "Run lane")).env)
        .CI_RUNNER_TEST_TIMEOUT_MS,
    ),
  );
  assert.ok(timeout >= 7_800_000, "six sequential cases need at least 130 minutes");
  assert.ok(
    Number(job["timeout-minutes"]) * 60_000 > timeout,
    "job must also allow setup and cleanup",
  );
  const secretStep = actionSteps.find(({ name }) => name === "Expose image cache credentials");
  assert.equal(evaluate(present(secretStep).if), true);
});
