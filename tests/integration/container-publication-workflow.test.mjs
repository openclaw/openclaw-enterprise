import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

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
  // Publication must require source verification for the same native build inputs.
  const check = JSON.parse(
    execFileSync(
      process.env.OCC_YQ_BIN ?? "yq",
      ["-o=json", ".", join(root, ".github/workflows/container-check.yml")],
      { encoding: "utf8" },
    ),
  );
  const steps = check.jobs.prepare.steps;
  const verification = steps.find((step) => step.with?.target === "openclaw-bridge-tests");
  const assembly = steps.find((step) => step.id === "build");
  assert.ok(verification);
  assert.ok(steps.indexOf(verification) < steps.indexOf(assembly));
  assert.equal(verification.if, "${{ matrix.image == 'runtime' }}");
  assert.equal(verification["continue-on-error"], undefined);
  assert.equal(assembly.if, undefined);
  assert.equal(verification.with.outputs, "type=cacheonly");
  for (const field of ["context", "file", "platforms", "build-args", "labels"]) {
    assert.deepEqual(verification.with[field], assembly.with[field], field);
  }
  assert.equal(workflow.jobs.prepare.uses, "./.github/workflows/container-check.yml");
  const handoff = steps.find((step) => step.with?.name?.startsWith("built-runtime-"));
  assert.equal(handoff.if, "${{ matrix.image == 'runtime' }}");
  const runtimeSmoke = check.jobs["runtime-smoke"];
  assert.equal(runtimeSmoke.needs, "prepare");
  assert.equal(runtimeSmoke.strategy["fail-fast"], false);
  const downloaded = runtimeSmoke.steps.find((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );
  assert.equal(downloaded.with.name, handoff.with.name);
  assert.equal(downloaded.with["run-id"], undefined);
  assert.equal(downloaded.with.pattern, undefined);
  const verified = runtimeSmoke.steps.find((step) => step.id === "verified");
  const smoke = runtimeSmoke.steps.find((step) =>
    step.run?.includes("container-release.mjs smoke"),
  );
  const qualified = runtimeSmoke.steps.find((step) =>
    step.with?.name?.startsWith("platform-runtime-"),
  );
  assert.ok(runtimeSmoke.steps.indexOf(downloaded) < runtimeSmoke.steps.indexOf(verified));
  assert.ok(runtimeSmoke.steps.indexOf(verified) < runtimeSmoke.steps.indexOf(smoke));
  assert.ok(runtimeSmoke.steps.indexOf(smoke) < runtimeSmoke.steps.indexOf(qualified));
  assert.equal(smoke.env.IMAGE_DIGEST, "${{ steps.verified.outputs.digest }}");
  assert.equal(smoke["continue-on-error"], undefined);
  assert.equal(qualified.if, undefined);
  assert.equal(runtimeSmoke.steps.find((step) => step.run?.includes("cleanup.mjs")).if, "always()");
  const controllerUpload = steps.find((step) => step.with?.name?.startsWith("platform-"));
  assert.equal(controllerUpload.if, "${{ matrix.image == 'controller' }}");

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

test("native runtime compilation uses spare capacity without overruling runner selection", () => {
  const check = JSON.parse(
    execFileSync(
      process.env.OCC_YQ_BIN ?? "yq",
      ["-o=json", ".", join(root, ".github/workflows/container-check.yml")],
      { encoding: "utf8" },
    ),
  );
  const prepare = check.jobs.prepare;
  const armRuntime = prepare.strategy.matrix.include.find(
    (row) => row.image === "runtime" && row.arch === "arm64",
  );
  assert.equal(
    armRuntime.runner,
    "${{ vars.CONTAINER_ARM64_RUNNER || 'blacksmith-16vcpu-ubuntu-2404-arm' }}",
  );
  assert.equal(
    prepare.strategy.matrix.include.find((row) => row.arch === "arm64" && !row.image).runner,
    "${{ vars.CONTAINER_ARM64_RUNNER || 'blacksmith-8vcpu-ubuntu-2404-arm' }}",
  );
  const report = prepare.steps.find((step) => step.id === "resources");
  const script = report.run.match(/node <<'NODE'\n([\s\S]*?)\nNODE/)[1];
  const GiB = 1024 ** 3;
  // Execute the shipped reporting step against kernel/API observations. This
  // checks admission and output wiring, not scheduler capacity or build success.
  for (const scenario of [
    { name: "spare ARM capacity", expected: 8 },
    { name: "visible root memory pressure", rootHigh: 40 * GiB, rootUsed: 12 * GiB, expected: 4 },
    { name: "visible root CPU quota", rootQuota: "800000 100000", expected: 4 },
    { name: "blank root memory usage", rootHigh: 40 * GiB, rootUsed: " \t", expected: 4 },
    { name: "valid zero root memory usage", rootHigh: 40 * GiB, rootUsed: 0, expected: 8 },
    {
      name: "delegated root is current cgroup",
      cgroup: "0::/",
      rootHigh: 40 * GiB,
      rootUsed: 12 * GiB,
      expected: 4,
    },
    { name: "partial root observations", partialRoot: true, expected: 4 },
    { name: "unreadable root", deniedRoot: true, expected: 4 },
    { name: "smaller override", cpus: 8, expected: 4 },
    { name: "busy host", free: 39 * GiB, expected: 4 },
    { name: "process memory limit", constrained: 24 * GiB, expected: 4 },
    { name: "ancestor memory limit", max: 32 * GiB, expected: 4 },
    { name: "ancestor memory pressure", high: 48 * GiB, used: 9 * GiB, expected: 4 },
    { name: "ancestor CPU quota", quota: "800000 100000", expected: 4 },
    { name: "fractional CPU quota", quota: "50000 100000", expected: 4 },
    { name: "unknown controllers", missing: true, expected: 4 },
    { name: "legacy cgroup", cgroup: "2:cpu:/slice/leaf", expected: 4 },
    { name: "controller remains unchanged", image: "controller", expected: 4 },
    { name: "AMD64 remains unchanged", arch: "x64", expected: 4 },
  ]) {
    const arch = scenario.arch ?? "arm64";
    const output = [];
    const observed = [];
    const files = {
      "/proc/self/cgroup": scenario.cgroup ?? "0::/slice/leaf\n",
      "/sys/fs/cgroup/cgroup.controllers": "cpu memory",
      "/sys/fs/cgroup/slice/leaf/cpu.max": "max 100000",
      "/sys/fs/cgroup/slice/leaf/memory.max": "max",
      "/sys/fs/cgroup/slice/leaf/memory.high": "max",
      "/sys/fs/cgroup/slice/leaf/memory.current": "0",
      "/sys/fs/cgroup/slice/cpu.max": scenario.quota ?? "max 100000",
      "/sys/fs/cgroup/slice/memory.max": String(scenario.max ?? "max"),
      "/sys/fs/cgroup/slice/memory.high": String(scenario.high ?? "max"),
      "/sys/fs/cgroup/slice/memory.current": String(scenario.used ?? 0),
    };
    if (scenario.rootHigh !== undefined || scenario.rootQuota !== undefined) {
      Object.assign(files, {
        "/sys/fs/cgroup/cpu.max": scenario.rootQuota ?? "max 100000",
        "/sys/fs/cgroup/memory.max": "max",
        "/sys/fs/cgroup/memory.high": String(scenario.rootHigh ?? "max"),
        "/sys/fs/cgroup/memory.current": String(scenario.rootUsed ?? 0),
      });
    }
    if (scenario.partialRoot) {
      files["/sys/fs/cgroup/cpu.max"] = "max 100000";
    }
    const modules = {
      "node:path": path,
      "node:os": {
        availableParallelism: () => scenario.cpus ?? 16,
        totalmem: () => 48 * GiB,
        freemem: () => scenario.free ?? 44 * GiB,
      },
      "node:fs": {
        readFileSync: (name) => {
          if (scenario.missing || (scenario.deniedRoot && name === "/sys/fs/cgroup/cpu.max")) {
            throw Object.assign(new Error("unavailable"), { code: "EACCES" });
          }
          if (!(name in files)) {
            throw Object.assign(new Error("absent"), { code: "ENOENT" });
          }
          return files[name];
        },
        appendFileSync: (name, value) => {
          assert.equal(name, "output");
          output.push(value);
        },
      },
    };
    runInNewContext(script, {
      require: (name) => {
        assert.ok(name in modules);
        return modules[name];
      },
      process: {
        arch,
        env: {
          IMAGE: scenario.image ?? "runtime",
          PLATFORM: `linux/${arch === "x64" ? "amd64" : arch}`,
          GITHUB_OUTPUT: "output",
        },
        constrainedMemory: () => scenario.constrained ?? 0,
        availableMemory: () => 44 * GiB,
      },
      console: { log: (value) => observed.push(value) },
    });
    assert.deepEqual(output, [`node_build_jobs=${scenario.expected}\n`], scenario.name);
    assert.equal(observed[0].nodeBuildJobs, scenario.expected, scenario.name);
  }
  const assembly = prepare.steps.find((step) => step.id === "build");
  assert.ok(
    assembly.with["build-args"].includes(
      "format('NODE_BUILD_JOBS={0}', steps.resources.outputs.node_build_jobs)",
    ),
  );
});
