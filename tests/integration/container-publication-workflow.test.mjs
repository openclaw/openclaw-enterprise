import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflow = JSON.parse(
  execFileSync(
    process.env.OCC_YQ_BIN ?? "yq",
    ["-o=json", ".", join(root, ".github/workflows/container-publish.yml")],
    { encoding: "utf8" },
  ),
);

// These checks protect the release configuration contract, not GitHub's scheduler.
test("publication workflow requires explicit chart opt-in and a successful image job", () => {
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.equal(inputs.publish.type, "boolean");
  assert.equal(inputs.publish.default, false);
  assert.equal(inputs.publish_chart.type, "boolean");
  assert.equal(inputs.publish_chart.default, false);
  assert.equal(workflow.jobs.publish.if, "${{ inputs.publish }}");
  const chart = workflow.jobs["publish-chart"];
  assert.equal(chart.if, "${{ inputs.publish && inputs.publish_chart }}");
  assert.ok(chart.needs.includes("publish"));
  assert.ok(!workflow.jobs.publish.needs.includes("publish-chart"));
  for (const job of [workflow.jobs.publish, chart]) {
    assert.notEqual(job["continue-on-error"], true);
    assert.equal(job.environment, "container-publish");
  }
});

test("chart publication consumes the exact successful image receipt without archives", () => {
  const images = workflow.jobs.publish.steps;
  const chart = workflow.jobs["publish-chart"].steps;
  const receiptName = "container-publication-${{ github.run_id }}-${{ github.run_attempt }}";
  const upload = images.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  const download = chart.find((step) => step.uses?.startsWith("actions/download-artifact@"));
  assert.equal(upload.with.name, receiptName);
  assert.equal(upload.with.path, "${{ runner.temp }}/prepared/publication.json");
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.equal(download.with.name, receiptName);
  assert.equal(download.with.path, "${{ runner.temp }}/prepared");
  assert.equal(download.with["run-id"], undefined);
  assert.equal(download.with.repository, undefined);
  assert.equal(download.with.pattern, undefined);
  assert.ok(images.every((step) => !step.run?.includes("chart-release.mjs")));
  const publishIndex = chart.findIndex((step) => step.run?.includes("chart-release.mjs publish"));
  assert.ok(publishIndex > chart.indexOf(download));
});

test("publication keeps its lock across jobs and reports image success after chart failure", async (t) => {
  assert.deepEqual(workflow.concurrency, {
    group:
      "${{ inputs.publish && 'enterprise-container-publish' || format('enterprise-container-prepare-{0}', github.run_id) }}",
    "cancel-in-progress": false,
  });
  // Reacquiring the workflow's lock inside a job would deadlock the release.
  assert.equal(workflow.jobs.publish.concurrency, undefined);
  assert.equal(workflow.jobs["publish-chart"].concurrency, undefined);
  const summary = workflow.jobs.summary;
  assert.equal(summary.if, "${{ always() }}");
  assert.ok(summary.needs.includes("publish"));
  assert.ok(summary.needs.includes("publish-chart"));
  const step = summary.steps[0];
  assert.equal(step.env.IMAGE_RESULT, "${{ needs.publish.result }}");
  assert.equal(step.env.CHART_RESULT, "${{ needs.publish-chart.result }}");
  assert.equal(step.env.CHART_REQUESTED, "${{ inputs.publish && inputs.publish_chart }}");
  const directory = await mkdtemp(join(tmpdir(), "oce-publication-summary-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Execute the actual summary step for its meaningful terminal outcomes.
  // Supplied results represent GitHub context; this is not a hosted dispatch proof.
  for (const [imagesRequested, chartRequested, imageResult, chartResult] of [
    ["false", "false", "skipped", "skipped"],
    ["true", "false", "success", "skipped"],
    ["true", "true", "success", "success"],
    ["true", "true", "success", "failure"],
    ["true", "true", "failure", "skipped"],
  ]) {
    const path = join(
      directory,
      `${imagesRequested}-${chartRequested}-${imageResult}-${chartResult}.md`,
    );
    execFileSync("bash", ["-euo", "pipefail", "-c", step.run], {
      env: {
        ...process.env,
        IMAGES_REQUESTED: imagesRequested,
        CHART_REQUESTED: chartRequested,
        IMAGE_RESULT: imageResult,
        CHART_RESULT: chartResult,
        GITHUB_STEP_SUMMARY: path,
      },
    });
    const report = await readFile(path, "utf8");
    assert.ok(report.includes(`Images: requested=${imagesRequested}, result=${imageResult}`));
    assert.ok(
      report.includes(
        `Chart and OCE version tags: requested=${chartRequested}, result=${chartResult}`,
      ),
    );
  }
});
