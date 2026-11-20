import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function record(value: unknown, ...path: string[]): Record<string, unknown> {
  assert.ok(isRecord(value));
  let current = value;
  for (const key of path) {
    const next = current[key];
    assert.ok(isRecord(next));
    current = next;
  }
  return current;
}

function records(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  const entries: unknown[] = value;
  return entries.map((entry) => record(entry));
}

function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

function optionalText(value: unknown): string | undefined {
  return value == null ? undefined : text(value);
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value == null ? undefined : record(value);
}

function includes(value: unknown, item: string): boolean {
  assert.ok(typeof value === "string" || Array.isArray(value));
  const sequence: string | unknown[] = value;
  return sequence.includes(item);
}

const workflow: unknown = JSON.parse(
  execFileSync(
    process.env.OCC_YQ_BIN ?? "yq",
    ["-o=json", ".", join(root, ".github/workflows/container-publish.yml")],
    { encoding: "utf8" },
  ),
);

// These checks protect the release configuration contract, not GitHub's scheduler.
test("publication workflow requires explicit chart opt-in and a successful image job", () => {
  // Publication must require source verification for the same native build inputs.
  const check: unknown = JSON.parse(
    execFileSync(
      process.env.OCC_YQ_BIN ?? "yq",
      ["-o=json", ".", join(root, ".github/workflows/container-check.yml")],
      { encoding: "utf8" },
    ),
  );
  const steps = records(record(check, "jobs", "prepare").steps);
  const verification = steps.find(
    (step) => optionalRecord(step.with)?.target === "openclaw-bridge-tests",
  );
  const assembly = record(steps.find((step) => step.id === "build"));
  assert.ok(verification);
  assert.ok(steps.indexOf(verification) < steps.indexOf(assembly));
  assert.equal(verification.if, "${{ matrix.image == 'runtime' }}");
  assert.equal(verification["continue-on-error"], undefined);
  assert.equal(assembly.if, undefined);
  assert.equal(record(verification.with).outputs, "type=cacheonly");
  for (const field of ["context", "file", "platforms", "build-args", "labels"]) {
    assert.deepEqual(record(verification.with)[field], record(assembly.with)[field], field);
  }
  assert.equal(record(workflow, "jobs", "prepare").uses, "./.github/workflows/container-check.yml");
  const handoff = record(
    steps.find((step) =>
      optionalText(optionalRecord(step.with)?.name)?.startsWith("built-runtime-"),
    ),
  );
  assert.equal(handoff.if, "${{ matrix.image == 'runtime' }}");
  const runtimeSmoke = record(check, "jobs", "runtime-smoke");
  const smokeSteps = records(runtimeSmoke.steps);
  assert.equal(runtimeSmoke.needs, "prepare");
  assert.equal(record(runtimeSmoke.strategy)["fail-fast"], false);
  const downloaded = record(
    smokeSteps.find((step) => optionalText(step.uses)?.startsWith("actions/download-artifact@")),
  );
  assert.equal(record(downloaded.with).name, record(handoff.with).name);
  assert.equal(record(downloaded.with)["run-id"], undefined);
  assert.equal(record(downloaded.with).pattern, undefined);
  const verified = record(smokeSteps.find((step) => step.id === "verified"));
  const smoke = record(
    smokeSteps.find((step) => optionalText(step.run)?.includes("container-release.ts smoke")),
  );
  const qualified = record(
    smokeSteps.find((step) =>
      optionalText(optionalRecord(step.with)?.name)?.startsWith("platform-runtime-"),
    ),
  );
  assert.ok(smokeSteps.indexOf(downloaded) < smokeSteps.indexOf(verified));
  assert.ok(smokeSteps.indexOf(verified) < smokeSteps.indexOf(smoke));
  assert.ok(smokeSteps.indexOf(smoke) < smokeSteps.indexOf(qualified));
  assert.equal(record(smoke.env).IMAGE_DIGEST, "${{ steps.verified.outputs.digest }}");
  assert.equal(smoke["continue-on-error"], undefined);
  assert.equal(qualified.if, undefined);
  const cleanup = record(
    smokeSteps.find((step) => optionalText(step.run)?.startsWith("node scripts/ci/cleanup.ts ")),
  );
  assert.equal(cleanup.if, "always()");
  assert.equal(
    cleanup.run,
    'node scripts/ci/cleanup.ts --state "$RUNNER_TEMP/runtime-smoke-${{ matrix.arch }}.json"',
  );
  const controllerUpload = record(
    steps.find((step) => optionalText(optionalRecord(step.with)?.name)?.startsWith("platform-")),
  );
  assert.equal(controllerUpload.if, "${{ matrix.image == 'controller' }}");

  const inputs = record(workflow, "on", "workflow_dispatch", "inputs");
  assert.equal(record(inputs.publish).type, "boolean");
  assert.equal(record(inputs.publish).default, false);
  assert.equal(record(inputs.publish_chart).type, "boolean");
  assert.equal(record(inputs.publish_chart).default, false);
  assert.equal(record(workflow, "jobs", "publish").if, "${{ inputs.publish }}");
  const chart = record(workflow, "jobs", "publish-chart");
  assert.equal(chart.if, "${{ inputs.publish && inputs.publish_chart }}");
  assert.ok(includes(chart.needs, "publish"));
  assert.ok(!includes(record(workflow, "jobs", "publish").needs, "publish-chart"));
  for (const job of [record(workflow, "jobs", "publish"), chart]) {
    assert.notEqual(job["continue-on-error"], true);
    assert.equal(job.environment, "container-publish");
  }
});

test("chart publication consumes the exact successful image receipt without archives", () => {
  const images = records(record(workflow, "jobs", "publish").steps);
  const chart = records(record(workflow, "jobs", "publish-chart").steps);
  const receiptName = "container-publication-${{ github.run_id }}-${{ github.run_attempt }}";
  const upload = record(
    images.find((step) => optionalText(step.uses)?.startsWith("actions/upload-artifact@")),
  );
  const download = record(
    chart.find((step) => optionalText(step.uses)?.startsWith("actions/download-artifact@")),
  );
  assert.equal(record(upload.with).name, receiptName);
  assert.equal(record(upload.with).path, "${{ runner.temp }}/prepared/publication.json");
  assert.equal(record(upload.with)["if-no-files-found"], "error");
  assert.equal(record(download.with).name, receiptName);
  assert.equal(record(download.with).path, "${{ runner.temp }}/prepared");
  assert.equal(record(download.with)["run-id"], undefined);
  assert.equal(record(download.with).repository, undefined);
  assert.equal(record(download.with).pattern, undefined);
  assert.ok(images.every((step) => !optionalText(step.run)?.includes("chart-release.ts")));
  const publishIndex = chart.findIndex((step) =>
    optionalText(step.run)?.includes("chart-release.ts publish"),
  );
  assert.ok(publishIndex > chart.indexOf(download));
});

test("publication keeps its lock across jobs and reports image success after chart failure", async (t) => {
  assert.deepEqual(record(workflow).concurrency, {
    group:
      "${{ inputs.publish && 'enterprise-container-publish' || format('enterprise-container-prepare-{0}', github.run_id) }}",
    "cancel-in-progress": false,
  });
  // Reacquiring the workflow's lock inside a job would deadlock the release.
  assert.equal(record(workflow, "jobs", "publish").concurrency, undefined);
  assert.equal(record(workflow, "jobs", "publish-chart").concurrency, undefined);
  const summary = record(workflow, "jobs", "summary");
  assert.equal(summary.if, "${{ always() }}");
  assert.ok(includes(summary.needs, "publish"));
  assert.ok(includes(summary.needs, "publish-chart"));
  const step = record(records(summary.steps)[0]);
  assert.equal(record(step.env).IMAGE_RESULT, "${{ needs.publish.result }}");
  assert.equal(record(step.env).CHART_RESULT, "${{ needs.publish-chart.result }}");
  assert.equal(record(step.env).CHART_REQUESTED, "${{ inputs.publish && inputs.publish_chart }}");
  const directory = await temporaryDirectory(t, "oce-publication-summary-");
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
    execFileSync("bash", ["-euo", "pipefail", "-c", text(step.run)], {
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
