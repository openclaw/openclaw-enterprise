import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";

import {
  createRunnerFixture as fixture,
  currentSha,
  laneArgs,
  runRunnerSync,
  writeJson,
  writeRunnerManifest,
} from "../helpers/ci-runner-fixture.ts";
import { parseRunnerRecord, runnerRecord, runnerRecords } from "./ci-runner-result-records.ts";

export async function writeRunnerPrepareFixture(root: string) {
  await writeFile(
    join(root, "scripts/ci/prepare.ts"),
    [
      'import { appendFile } from "node:fs/promises";',
      "export async function prepareFile({ file, statePath }) {",
      "  if (file.path.endsWith('first.test.mjs')) {",
      "    return {",
      "      env: { CI_RUNNER_SCOPED_VALUE: 'one', OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: 'private.example/controller@sha256:' + 'a'.repeat(64), OCC_TEST_KUBERNETES_RUNTIME_IMAGE: 'private.example/runtime@sha256:' + 'b'.repeat(64), OCC_TEST_PRODUCTION_UPGRADE_CONTROLLER_IMAGE: 'private.example/controller@sha256:' + 'd'.repeat(64), OCC_TEST_PRODUCTION_UPGRADE_RUNTIME_IMAGE: 'private.example/runtime@sha256:' + 'e'.repeat(64), OCC_TEST_REPOSITORY_CREDENTIALS_IMAGE: 'private.example/broker@sha256:' + 'c'.repeat(64), OCC_TEST_PRODUCTION_NODE_IMAGE: 'untrusted-image-value' },",
      "      cleanup: async () => appendFile(statePath, `${file.path}\\n`),",
      "    };",
      "  }",
      "  return { cleanup: async () => appendFile(statePath, `${file.path}\\n`) };",
      "}",
      "",
    ].join("\n"),
  );
}

export async function checkRunnerManifest(t: TestContext) {
  const root = await fixture(t);
  const statePath = join(root, "state/lane.jsonl");
  const resultsPath = join(root, "results/baseline.json");
  await writeRunnerPrepareFixture(root);

  await writeFile(
    join(root, "tests/integration/first.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { writeFileSync } from "node:fs";',
      'import test from "node:test";',
      "writeFileSync(process.env.CI_RUNNER_PROCESS_RECORD, String(process.ppid));",
      'test("first file sees scoped env", () => {',
      '  assert.equal(process.env.CI_RUNNER_SCOPED_VALUE, "one");',
      "  assert.equal(process.env.ACTIONS_RUNTIME_TOKEN, undefined);",
      "  assert.equal(process.env.ACTIONS_RESULTS_URL, undefined);",
      "  assert.match(process.env.OCC_TEST_PRODUCTION_UPGRADE_CONTROLLER_IMAGE, /@sha256:d{64}$/);",
      "  assert.match(process.env.OCC_TEST_PRODUCTION_UPGRADE_RUNTIME_IMAGE, /@sha256:e{64}$/);",
      "});",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "tests/integration/second.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'test("second file does not inherit scoped env", () => {',
      "  assert.equal(process.env.CI_RUNNER_SCOPED_VALUE, undefined);",
      "});",
      "",
    ].join("\n"),
  );
  // Lane documents follow the manifest, but test paths still follow --root.
  await mkdir(join(root, "manifests/lanes"), { recursive: true });
  await writeJson(join(root, "manifests/lanes/baseline.json"), {
    requiredEnv: [
      "OCC_PROBE_CONTROLLER_IMAGE",
      "OCC_PROBE_BROKER_IMAGE",
      "OCC_PROBE_OLD_CONTROLLER_IMAGE",
      "OCC_PROBE_OLD_BROKER_IMAGE",
      "OCC_TEST_RELEASED_CONTROLLER_IMAGE",
      "OCC_TEST_CANDIDATE_CONTROLLER_IMAGE",
    ],
    files: [
      {
        path: "tests/integration/first.test.mjs",
        expectedTests: ["first file sees scoped env"],
      },
      {
        path: "tests/integration/second.test.mjs",
        expectedTests: ["second file does not inherit scoped env"],
      },
    ],
  });
  await writeRunnerManifest(
    root,
    { lanes: { baseline: "./lanes/baseline.json" } },
    "manifests/suites.json",
  );

  const result = runRunnerSync(
    laneArgs(root, "baseline", statePath, resultsPath, "manifests/suites.json"),
    {
      CI_RUNNER_PROCESS_RECORD: join(root, "state/process-group"),
      ACTIONS_RUNTIME_TOKEN: "synthetic-cache-token",
      ACTIONS_RESULTS_URL: "https://cache.example.test/",
      OCC_PROBE_CONTROLLER_IMAGE: `private.example/current-controller@sha256:${"b".repeat(64)}`,
      OCC_PROBE_BROKER_IMAGE: `private.example/current-broker@sha256:${"c".repeat(64)}`,
      OCC_PROBE_OLD_CONTROLLER_IMAGE: `private.example/old-controller@sha256:${"d".repeat(64)}`,
      OCC_PROBE_OLD_BROKER_IMAGE: `private.example/old-broker@sha256:${"e".repeat(64)}`,
      OCC_TEST_RELEASED_CONTROLLER_IMAGE: `private.example/released-controller@sha256:${"f".repeat(64)}`,
      OCC_TEST_CANDIDATE_CONTROLLER_IMAGE: `private.example/candidate-controller@sha256:${"1".repeat(64)}`,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const summary = parseRunnerRecord(await readFile(resultsPath, "utf8"), "lane result");
  const counts = runnerRecord(summary.counts, "lane counts");
  const files = runnerRecords(summary.files, "file results");
  const [first, second] = files;
  assert(first && second, "Expected results for both files");
  assert.equal(summary.sourceSha, currentSha());
  assert.equal(summary.status, "passed");
  assert.equal(counts.passed, 2);
  assert.equal(counts.skipped, 0);
  assert.deepEqual(
    files.map((file) => file.path),
    ["tests/integration/first.test.mjs", "tests/integration/second.test.mjs"],
  );
  assert.equal(runnerRecord(first.cleanup, "file cleanup").status, "passed");
  // The test child reports its real parent, the detached Node runner's group leader.
  assert.equal(
    first.processGroupId,
    Number(await readFile(join(root, "state/process-group"), "utf8")),
  );
  assert.ok(
    files.every(
      (file) =>
        typeof file.wallDurationMs === "number" &&
        Number.isInteger(file.wallDurationMs) &&
        file.wallDurationMs >= 0,
    ),
  );
  // Evidence must retain immutable identity without exporting private registry names
  // or arbitrary prepared environment values alongside the public CI artifact.
  const pairDigests = {
    pairController: `sha256:${"b".repeat(64)}`,
    pairBroker: `sha256:${"c".repeat(64)}`,
    pairOldController: `sha256:${"d".repeat(64)}`,
    pairOldBroker: `sha256:${"e".repeat(64)}`,
    releasedController: `sha256:${"f".repeat(64)}`,
    candidateController: `sha256:${"1".repeat(64)}`,
  };
  assert.deepEqual(first.imageDigests, {
    controller: `sha256:${"a".repeat(64)}`,
    runtime: `sha256:${"b".repeat(64)}`,
    controllerUpgrade: `sha256:${"d".repeat(64)}`,
    runtimeUpgrade: `sha256:${"e".repeat(64)}`,
    repositoryCredentials: `sha256:${"c".repeat(64)}`,
    ...pairDigests,
  });
  assert.deepEqual(second.imageDigests, pairDigests);
  assert.doesNotMatch(JSON.stringify(summary), /private\.example|untrusted-image-value/);
  assert.match(await readFile(statePath, "utf8"), /first\.test\.mjs/);
}
