import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import pluginInstallReporter, {
  pluginInstallResult,
} from "../helpers/openshell-plugin-install-reporter.ts";
import {
  createRunnerFixture,
  laneArgs,
  runnerArtifactPaths,
  runRunnerSync,
  writeRunnerManifest,
  writeSingleFileRunnerLane,
} from "../helpers/ci-runner-fixture.ts";

const reporter = new URL("../helpers/openshell-plugin-install-reporter.ts", import.meta.url).href;
const stages = new URL("../helpers/openshell-stage.mjs", import.meta.url).href;
const progress = new URL("../../scripts/ci/openshell-progress.mjs", import.meta.url).href;
const caseName = "OpenShell installs selected Codex plugins before WebSocket startup";
const outerCaseName = "OpenShell Agent workflow installs and retains selected Codex plugins";
const sentinel = "invented-plugin-diagnostic-sentinel";
const incomplete =
  "OpenShell plugin installation did not complete one exact passing case; child details withheld.";

for (const scenario of ["installation-failure", "no-frame", "invalid-frame"] as const) {
  test(`plugin wrapper reports the latest validated stage for ${scenario}`, async (t) => {
    const root = await createRunnerFixture(t);
    const file = "tests/integration/openshell-plugin-install-real.test.ts";
    const child = "tests/integration/sandbox-driver-openshell-k3d-real.test.mjs";
    const prepareMarker = join(root, "prepare-marker");
    const childMarker = join(root, "child-marker");
    // Use the registered outer test and real reporters with a disposable child and preparation.
    await copyFile(
      new URL("./openshell-plugin-install-real.test.ts", import.meta.url),
      join(root, file),
    );
    await mkdir(join(root, "tests/helpers"));
    await writeFile(
      join(root, "tests/helpers/openshell-plugin-install-reporter.ts"),
      `export { runPluginInstallCase } from ${JSON.stringify(reporter)};`,
    );
    await writeFile(
      join(root, "scripts/ci/prepare.mjs"),
      'export { prepareFile } from "./prepare-fixture.ts";\n',
    );
    await writeFile(
      join(root, "scripts/ci/prepare-fixture.ts"),
      `import { rm, writeFile } from "node:fs/promises";
const marker = ${JSON.stringify(prepareMarker)};
export async function prepareFile() {
  await writeFile(marker, "prepared");
  return { env: { OCC_TEST_OPENSHELL_K3D_REAL: "1" }, cleanup: () => rm(marker) };
}
`,
    );
    await writeFile(join(root, child), `import "./plugin-stage-fixture.ts";\n`);
    await writeFile(
      join(root, "tests/integration/plugin-stage-fixture.ts"),
      `import test, { after } from "node:test";
import { writeFile } from "node:fs/promises";
import { runOpenShellStage } from ${JSON.stringify(stages)};
import { emitOpenShellProgress, openShellProgressPrefix } from ${JSON.stringify(progress)};
const scenario = ${JSON.stringify(scenario)};
const fail = () => { throw new Error(${JSON.stringify(sentinel)}); };
after(() => writeFile(${JSON.stringify(childMarker)}, "completed"));
test(${JSON.stringify(caseName)}, async (t) => {
  if (scenario === "installation-failure") {
    await runOpenShellStage(t, "installation", fail);
  }
  if (scenario === "invalid-frame") {
    console.log(openShellProgressPrefix + "{malformed");
    console.log(openShellProgressPrefix + JSON.stringify({kind: "openshell-stage", stage: "unrecognized-stage", outcome: "started"}));
    console.log(openShellProgressPrefix + JSON.stringify({kind: "openshell-stage", stage: "installation", outcome: "started", extra: ${JSON.stringify(sentinel)}}));
    emitOpenShellProgress("initial-model", "started");
    emitOpenShellProgress("exposure-auth", "started");
    emitOpenShellProgress("installation", "failed");
  }
  fail();
});
`,
    );
    const lane = "openshell-policy";
    await writeRunnerManifest(root, {
      lanes: { [lane]: { files: [{ path: file, expectedTests: [outerCaseName] }] } },
    });
    const { statePath, resultsPath } = runnerArtifactPaths(root, lane);
    const run = runRunnerSync(laneArgs(root, lane, statePath, resultsPath), {}, { timeout: 20000 });
    const resultText = await readFile(resultsPath, "utf8");
    const result = JSON.parse(resultText);
    const [fileResult] = result.files;
    assert.equal(run.status, 1, run.stderr);
    assert.equal(result.exitCode, 1);
    assert.equal(fileResult.nodeExitCode, 1);
    assert.deepEqual(result.counts, { passed: 0, failed: 1, skipped: 0, todo: 0, total: 1 });
    assert.deepEqual(fileResult.cleanup, { status: "passed" });
    assert.equal(await readFile(childMarker, "utf8"), "completed");
    await assert.rejects(readFile(prepareMarker), { code: "ENOENT" });
    assert.doesNotMatch(run.stdout + run.stderr + resultText, new RegExp(sentinel));
    assert.deepEqual(fileResult.installationPhases, { phases: [], truncated: false });
    const measured = scenario === "installation-failure";
    const summary = "OpenShell plugin installation case failed; child details withheld.";
    const stage = "\nLast reported OpenShell stage was installation (failed).";
    assert.equal(fileResult.tests[0].error.message, measured ? summary + stage : summary);
    assert.deepEqual(
      fileResult.measurements,
      measured
        ? [{ kind: "openshell-plugin-stage", stage: "installation", outcome: "failed" }]
        : undefined,
    );
  });
}

for (const scenario of ["failure", "timeout", "success", "skip", "todo", "extra-pass"] as const) {
  test(`plugin reporter preserves strict ${scenario} through the Node and CI transports`, async (t) => {
    const root = await createRunnerFixture(t);
    const child = join(root, "child.test.ts");
    // These are real Node test workers and real stage emitters, without a product
    // fixture. Noise includes a valid stderr stage and an extra-field stdout event.
    await writeFile(
      child,
      `import test from "node:test";
import { runOpenShellStage } from ${JSON.stringify(stages)};
import { openShellProgressPrefix, emitOpenShellProgress } from ${JSON.stringify(progress)};
test(${JSON.stringify(caseName)}, ${JSON.stringify({ skip: scenario === "skip", todo: scenario === "todo" })}, async (t) => {
  await runOpenShellStage(t, "installation", async () => {
    ${scenario === "success" ? 'for (let index = 0; index < 1024; index += 1) emitOpenShellProgress("installation", "started");' : ""}
  });
  await runOpenShellStage(t, "exposure-auth", async () => {
    ${scenario === "timeout" ? 'process.stdout.write(openShellProgressPrefix + JSON.stringify({kind: "openshell-stage", stage: "installation", outcome: "failed"})); await new Promise(resolve => setTimeout(resolve, 60_000));' : ""}
  });
  emitOpenShellProgress("installation", "started");
  emitOpenShellProgress("exposure-auth", "failed");
  console.log(${JSON.stringify(sentinel)});
  console.error(${JSON.stringify(sentinel)});
  process.stderr.write(openShellProgressPrefix + JSON.stringify({kind: "openshell-stage", stage: "installation", outcome: "failed"}) + "\\n");
  console.log(openShellProgressPrefix + JSON.stringify({kind: "openshell-stage", stage: "installation", outcome: "failed", extra: ${JSON.stringify(sentinel)}}));
  emitOpenShellProgress("initial-model", "started");
  console.log(openShellProgressPrefix + JSON.stringify({kind: "openshell-installation", stage: "workspace-helm", invocation: 1, outcome: "entered", offsetMs: 12}));
  console.log(openShellProgressPrefix + JSON.stringify({kind: "openshell-stage-failure", stage: "installation", category: "Error", code: null, location: "tests/helpers/openshell-sandbox-workflows.mjs"}));
  console.log("x".repeat(300) + openShellProgressPrefix + JSON.stringify({kind: "openshell-stage", stage: "installation", outcome: "failed"}));
  process.stdout.write(openShellProgressPrefix + JSON.stringify({kind: "openshell-stage", stage: "installation", outcome: "failed"}));
  ${scenario === "failure" ? `throw new Error(${JSON.stringify(sentinel)});` : ""}
});
${scenario === "extra-pass" ? `test(${JSON.stringify(caseName)}, () => {});` : ""}
`,
    );
    const file = "tests/integration/wrapper.test.ts";
    await writeSingleFileRunnerLane(
      root,
      "single",
      file,
      `import test from "node:test";
import { runPluginInstallCase } from ${JSON.stringify(reporter)};
test("plugin wrapper", (t) => runPluginInstallCase(${JSON.stringify(child)}, ${scenario === "timeout" ? 4000 : 10000}, t));
`,
    );
    const { statePath, resultsPath } = runnerArtifactPaths(root, "single");
    const run = runRunnerSync(
      laneArgs(root, "single", statePath, resultsPath),
      {},
      { timeout: 20000 },
    );
    const resultText = await readFile(resultsPath, "utf8");
    const result = JSON.parse(resultText);
    const passed = scenario === "success";
    assert.equal(run.status, passed ? 0 : 1, run.stderr);
    assert.deepEqual(result.counts, {
      passed: passed ? 1 : 0,
      failed: passed ? 0 : 1,
      skipped: 0,
      todo: 0,
      total: 1,
    });
    const output = run.stdout + run.stderr + resultText;
    assert.doesNotMatch(output, new RegExp(sentinel));
    assert.doesNotMatch(
      output,
      /initial-model|openshell-stage-failure|openshell-installation|elapsedMs/,
    );
    const outcome = scenario === "timeout" ? "started" : "passed";
    assert.deepEqual(
      result.files[0].measurements,
      passed || scenario === "skip"
        ? undefined
        : [{ kind: "openshell-plugin-stage", stage: "exposure-auth", outcome }],
    );
    const message = result.files[0].tests[0].error?.message;
    if (passed) {
      assert.equal(message, undefined);
      assert.doesNotMatch(run.stderr, /Last reported OpenShell stage/);
      return;
    }
    const summary =
      scenario === "timeout"
        ? "OpenShell plugin installation child timed out; child details withheld."
        : scenario === "failure"
          ? "OpenShell plugin installation case failed; child details withheld."
          : incomplete;
    const stage = `Last reported OpenShell stage was exposure-auth (${outcome}).`;
    // The real CI lane result keeps the original failure and last observed stage.
    assert.equal(message, scenario === "skip" ? summary : `${summary}\n${stage}`);
    assert.ok(run.stderr.includes(summary));
    assert.equal(run.stderr.includes(stage), scenario !== "skip");
  });
}

function stageFrame(stage: string, outcome: string) {
  return `openclaw-ci-progress ${JSON.stringify({ kind: "openshell-stage", stage, outcome })}\n`;
}

test("the Node reporter forwards at most the four ordered plugin checkpoints", async () => {
  const start = stageFrame("installation", "started");
  const installed = stageFrame("installation", "passed");
  const exposure = stageFrame("exposure-auth", "started");
  const exposed = stageFrame("exposure-auth", "passed");
  const completed = start + installed + exposure + exposed;
  const events = async function* () {
    yield {
      type: "test:stdout",
      data: {
        message:
          exposure +
          start.repeat(1024) +
          installed +
          start +
          exposure +
          exposed +
          stageFrame("exposure-auth", "failed").repeat(1024),
      },
    };
    yield { type: "test:pass", data: { name: caseName, nesting: 0, details: { type: "test" } } };
    yield {
      type: "test:summary",
      data: {
        success: true,
        counts: { tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0 },
      },
    };
  };
  let output = "";
  for await (const frame of pluginInstallReporter(events())) {
    output += frame;
  }
  assert.equal(output.length, completed.length + '"passed"'.length);
  assert.equal(output, completed + '"passed"');
});

test("invalid plugin transitions preserve the last accepted stage and cannot pass", () => {
  const start = stageFrame("installation", "started");
  const installed = stageFrame("installation", "passed");
  const exposure = stageFrame("exposure-auth", "started");
  const exposed = stageFrame("exposure-auth", "passed");
  const failed = stageFrame("installation", "failed");
  for (const [valid, invalid, expected] of [
    ["", exposure, undefined],
    [start, start, { stage: "installation", outcome: "started" }],
    [start + installed, start, { stage: "installation", outcome: "passed" }],
    [start + failed, exposure, { stage: "installation", outcome: "failed" }],
    [
      start + installed + exposure + exposed,
      stageFrame("exposure-auth", "failed"),
      { stage: "exposure-auth", outcome: "passed" },
    ],
  ] as const) {
    const { failure, progress } = pluginInstallResult(valid + invalid + '"passed"', true);
    assert.equal(failure, incomplete);
    assert.deepEqual(progress, expected && { kind: "openshell-stage", ...expected });
  }
});

test("plugin progress framing never relaxes terminal admission", () => {
  const stage = stageFrame("installation", "started");
  assert.equal(pluginInstallResult(stage + '"passed"', true).failure, undefined);
  for (const suffix of ['"passed"\n', '"passed""passed"', '"passed"junk', "", "{", "null"]) {
    assert.equal(pluginInstallResult(stage + suffix, true).failure, incomplete);
  }
  for (const prefix of [
    stage.trimEnd(),
    stage.replace('"started"}', '"started","extra":1}'),
    "junk\n",
  ]) {
    assert.equal(pluginInstallResult(prefix + '"passed"', true).failure, incomplete);
  }
  assert.equal(pluginInstallResult(stage + '"passed"', false).failure, incomplete);
  assert.match(pluginInstallResult(stage + '"passed"', true, true).failure!, /timed out/);
});
