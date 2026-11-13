import assert from "node:assert/strict";
import { mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  aggregateArgs,
  createRunnerFixture,
  laneArgs,
  runRunnerSync,
  writeJson,
  writeRunnerManifest,
} from "../helpers/ci-runner-fixture.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

interface RunnerSummary {
  scope: string;
  testName?: string;
  counts: { passed: number; failed: number; skipped: number; todo: number; total: number };
  files: {
    path: string;
    nodeExitCode: number | null;
    tests: { name: string; status: string }[];
    cleanup: { status: string };
  }[];
  issues: {
    code: string;
    lane?: string;
    env?: string;
    name?: string;
    status?: string;
    file?: string;
    source?: { file: string; line: number; column: number; nesting: number };
  }[];
}

async function runCaseLane(
  root: string,
  lane: string,
  resultName: string,
  selectors: readonly string[] = [],
  env: NodeJS.ProcessEnv = {},
) {
  const resultsPath = join(root, "results", `${resultName}.json`);
  const result = runRunnerSync(
    [...laneArgs(root, lane, `state/${lane}.jsonl`, resultsPath), ...selectors],
    env,
  );
  assert.ifError(result.error);
  const summary: RunnerSummary = JSON.parse(await readFile(resultsPath, "utf8"));
  return { result, summary };
}

test("focused runs retain case enforcement and cleanup but cannot complete a full lane", async (t) => {
  const root = await createRunnerFixture(t);
  // Keep an independent witness of cleanup for the selected file.
  await writeFile(
    join(root, "scripts/ci/prepare.mjs"),
    [
      'import { appendFile } from "node:fs/promises";',
      "export function prepareFile({ file, statePath }) {",
      '  return { cleanup: () => appendFile(statePath, file.path + "\\n") };',
      "}",
      "",
    ].join("\n"),
  );
  const selectedPath = "tests/integration/first.test.mjs";
  const selected = { path: selectedPath, expectedTests: ["required case"] };
  await writeFile(
    join(root, selectedPath),
    'import test from "node:test"; test("required case", () => {});\n',
  );
  await writeFile(
    join(root, "tests/integration/second.test.mjs"),
    'throw new Error("unselected file executed");\n',
  );
  const fileOnlyLanes = {
    baseline: { files: [selected, { path: "tests/integration/second.test.mjs" }] },
    single: { files: [selected] },
  };
  await writeRunnerManifest(root, { lanes: fileOnlyLanes, groups: { ci: ["baseline"] } });
  const fileSelector = ["--file", selectedPath];
  for (const lane of ["baseline", "single"]) {
    const { result, summary } = await runCaseLane(root, lane, lane, fileSelector);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(summary.scope, "focused");
    assert.deepEqual(
      summary.files.map((file) => file.path),
      [selectedPath],
    );
    assert.equal(summary.files[0]?.cleanup.status, "passed");
    assert.equal(await readFile(join(root, `state/${lane}.jsonl`), "utf8"), `${selectedPath}\n`);
    // Even a one-file lane cannot turn explicitly focused proof into full qualification.
    const aggregated = runRunnerSync(aggregateArgs(root, lane));
    assert.equal(aggregated.status, 1, aggregated.stderr);
    const evidence: Pick<RunnerSummary, "issues"> = JSON.parse(aggregated.stdout);
    assert.ok(evidence.issues.some(({ code }) => code === "focused-lane-evidence"));
    if (lane === "baseline") {
      assert.ok(evidence.issues.some(({ code }) => code === "missing-lane-evidence"));
    }
  }
  // The literal name must reach the actual Node child. The other required
  // case must not execute, but the result remains focused evidence.
  const testName = "required case";
  const singleManifest = (name: string) =>
    writeRunnerManifest(root, {
      lanes: {
        single: {
          files: [{ path: selectedPath, expectedTests: [name, "unselected required case"] }],
        },
      },
    });
  await singleManifest(testName);
  await writeFile(
    join(root, selectedPath),
    [
      'import test from "node:test";',
      'test("required case", () => {});',
      'test("unselected required case", () => { throw new Error("unselected case executed"); });',
    ].join("\n"),
  );
  // This aggregate control needs the canonical single-lane filename again.
  await unlink(join(root, "results/single.json"));
  const { result: filtered, summary: focused } = await runCaseLane(root, "single", "single", [
    ...fileSelector,
    "--test-name",
    testName,
  ]);
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.equal(focused.scope, "focused");
  assert.equal(focused.testName, testName);
  assert.deepEqual(focused.counts, { passed: 1, failed: 0, skipped: 0, todo: 0, total: 1 });
  assert.deepEqual(
    focused.files[0]?.tests.map(({ name }) => name),
    [testName],
  );
  assert.equal(focused.files[0]?.cleanup.status, "passed");
  const filteredAggregate = runRunnerSync(aggregateArgs(root, "single"));
  assert.equal(filteredAggregate.status, 1, filteredAggregate.stderr);
  const filteredEvidence: Pick<RunnerSummary, "issues"> = JSON.parse(filteredAggregate.stdout);
  assert.ok(filteredEvidence.issues.some(({ code }) => code === "focused-lane-evidence"));

  // Node can also match trimmed ancestry. Reject every extra or differently
  // named test, and reject suites/subtests even when named as the file wrapper.
  const invalidNames = [
    {
      name: "no match",
      testName: "absent",
      source: 'test("required case", () => {});',
      issue: "invalid-test-selection",
    },
    {
      name: "unregistered existing case",
      testName: "unregistered",
      source: 'test("unregistered", () => {});',
      issue: "invalid-test-selection",
    },
    {
      name: "missing selected expectation",
      source: 'test("different case", () => {});',
      issue: "missing-expected-test",
    },
    {
      name: "trimmed name is not exact",
      source: 'test(" required case ", () => {});',
      issue: "unexpected-test-selection",
    },
    {
      name: "additional trimmed name",
      source: 'test("required case", () => {}); test(" required case ", () => {});',
      issue: "unexpected-test-selection",
    },
    {
      name: "duplicate exact name",
      source: 'test("required case", () => {}); test("required case", () => {});',
      issue: "unexpected-test-selection",
    },
    {
      name: "selected skip",
      source: 'test.skip("required case", () => {});',
      issue: "unexpected-skip",
    },
    { name: "selected todo", source: 'test.todo("required case");', issue: "unexpected-skip" },
    {
      name: "nested case",
      source: 'test("required case", async (t) => { await t.test("descendant", () => {}); });',
      issue: "unsupported-test-selection",
    },
    {
      name: "nested case named as the file wrapper",
      source:
        'test("required case", async (t) => { await t.test(new URL(import.meta.url).pathname, () => {}); });',
      issue: "unsupported-test-selection",
    },
    {
      name: "suite",
      source: 'describe("required case", () => { test("descendant", () => {}); });',
      issue: "unsupported-test-selection",
    },
    {
      name: "nested suite named as the file wrapper",
      source:
        'describe("required case", () => { describe(new URL(import.meta.url).pathname, () => {}); });',
      issue: "unsupported-test-selection",
    },
  ];
  for (const [index, scenario] of invalidNames.entries()) {
    await writeFile(
      join(root, selectedPath),
      `import test, { describe } from "node:test";\n${scenario.source}\n`,
    );
    const { result, summary: evidence } = await runCaseLane(
      root,
      "single",
      `invalid-name-${index}`,
      [...fileSelector, "--test-name", scenario.testName ?? testName],
    );
    assert.equal(result.status, 1, `${scenario.name}: ${result.stderr}`);
    assert.ok(
      evidence.issues.some(({ code }) => code === scenario.issue),
      JSON.stringify(evidence.issues),
    );
    assert.equal(evidence.scope, "focused");
    assert.equal(evidence.testName, scenario.testName ?? testName);
    if (scenario.issue === "invalid-test-selection") {
      assert.deepEqual(evidence.files, []);
    } else {
      assert.equal(evidence.files[0]?.cleanup.status, "passed");
    }
  }

  // Regex metacharacters are literal. A 256-byte UTF-8 name is accepted, and
  // the manifest and reported name must both match exactly.
  const literalNames = ["--dry-run=preserves state", "literal [case].* /i", "é".repeat(128)];
  for (const [index, name] of literalNames.entries()) {
    await singleManifest(name);
    await writeFile(
      join(root, selectedPath),
      `import test from "node:test";
      test(${JSON.stringify(name)}, () => {});
      test("unselected required case", () => { throw new Error("unselected case executed"); });\n`,
    );
    // A leading switch-like name needs the equals form; the throwing sibling
    // proves that exactly the selected literal reaches the child.
    const selector = name.startsWith("--") ? [`--test-name=${name}`] : ["--test-name", name];
    const { result, summary: evidence } = await runCaseLane(
      root,
      "single",
      `literal-name-${index}`,
      [...fileSelector, ...selector],
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(evidence.scope, "focused");
    assert.equal(evidence.testName, name);
    assert.deepEqual(evidence.counts, { passed: 1, failed: 0, skipped: 0, todo: 0, total: 1 });
    assert.deepEqual(
      evidence.files[0]?.tests.map(({ name }) => name),
      [name],
    );
    assert.equal(evidence.files[0]?.cleanup.status, "passed");
  }

  // Restore the file-only lanes for their unchanged missing-case contract.
  await writeRunnerManifest(root, { lanes: fileOnlyLanes, groups: { ci: ["baseline"] } });
  // A green Node process is insufficient when the selected file omits its required case.
  await writeFile(
    join(root, selectedPath),
    'import test from "node:test"; test("different case", () => {});\n',
  );
  const { result: missing, summary } = await runCaseLane(
    root,
    "baseline",
    "missing-case",
    fileSelector,
  );
  assert.equal(missing.status, 1, missing.stderr);
  assert.ok(summary.issues.some(({ code }) => code === "missing-expected-test"));
  assert.equal(summary.files[0]?.cleanup.status, "passed");
  const stateBefore = await readFile(join(root, "state/baseline.jsonl"), "utf8");
  const invalidPaths = [
    "tests/integration/unknown.test.mjs",
    "tests/integration/../integration/first.test.mjs",
  ];
  for (const [index, path] of invalidPaths.entries()) {
    const { result: invalid, summary: rejected } = await runCaseLane(
      root,
      "baseline",
      `invalid-file-${index}`,
      ["--file", path],
    );
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.deepEqual(rejected.files, []);
    assert.ok(rejected.issues.some(({ code }) => code === "invalid-file-selection"));
    assert.equal(await readFile(join(root, "state/baseline.jsonl"), "utf8"), stateBefore);
  }
});

test("run fails missing expected tests, skipped expected tests, skips, todos, and missing required env", async (t) => {
  const root = await createRunnerFixture(t);
  const path = "tests/integration/skips.test.mjs";
  const lane = "lane";
  const laneInput = "CI_RUNNER_REQUIRED_INPUT";
  const fileInput = "CI_RUNNER_FILE_INPUT";
  const clearedInputs = { [laneInput]: undefined, [fileInput]: undefined };
  const suppliedValue = "fixture-input";
  const inputFile = { path, expectedTests: ["accepted input"] };

  // A top-level marker distinguishes refusing the input from a child that starts and fails.
  await writeFile(
    join(root, path),
    [
      'import assert from "node:assert/strict";',
      'import { readFileSync, writeFileSync } from "node:fs";',
      'import test from "node:test";',
      'const inputs = new URL("./required-input.json", import.meta.url);',
      'const { marker, variable, expectedValue } = JSON.parse(readFileSync(inputs, "utf8"));',
      'writeFileSync(marker, "started\\n");',
      'test("accepted input", () => assert.equal(process.env[variable], expectedValue));',
    ].join("\n"),
  );

  for (const { scope, variable, definition } of [
    {
      scope: "lane",
      variable: laneInput,
      definition: { files: [inputFile], requiredEnv: [laneInput] },
    },
    {
      scope: "file",
      variable: fileInput,
      definition: { files: [{ ...inputFile, requiredEnv: [fileInput] }] },
    },
  ]) {
    const marker = join(root, "state", scope + "-child-started");
    await writeJson(join(root, "tests/integration/required-input.json"), {
      marker,
      variable,
      expectedValue: suppliedValue,
    });
    await writeRunnerManifest(root, { lanes: { [lane]: definition } });

    const missing = await runCaseLane(root, lane, scope + "-missing", [], clearedInputs);
    assert.deepEqual(
      missing.summary.issues.map(({ code, env, lane }) => [code, env, lane]),
      [["missing-env", variable, lane]],
    );
    assert.equal(missing.result.status, 1, missing.result.stderr);
    assert.deepEqual(
      missing.summary.files.map(({ path, nodeExitCode, tests }) => ({ path, nodeExitCode, tests })),
      [{ path, nodeExitCode: null, tests: [] }],
    );
    await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" });

    // Supply only the missing variable to the same manifest and child.
    const supplied = await runCaseLane(root, lane, scope + "-supplied", [], {
      ...clearedInputs,
      [variable]: suppliedValue,
    });
    assert.equal(supplied.result.status, 0, supplied.result.stderr);
    assert.deepEqual(supplied.summary.issues, []);
    assert.equal(supplied.summary.files[0]?.nodeExitCode, 0);
    assert.deepEqual(
      supplied.summary.files[0]?.tests.map(({ name, status }) => [name, status]),
      [["accepted input", "passed"]],
    );
    assert.equal(await readFile(marker, "utf8"), "started\n");
  }

  await writeFile(
    join(root, path),
    [
      'import assert from "node:assert/strict";',
      'import test, { describe } from "node:test";',
      'test("ordinary pass", () => assert.equal(1, 1));',
      'test("expected but skipped", { skip: "not allowed for expected" }, () => {});',
      'test("unexpected skipped case", { skip: "missing prerequisite" }, () => {});',
      'test("todo case", { todo: "missing prerequisite" }, () => {});',
      // A skipped suite reports no test event for the cases it never registered.
      'describe("skipped suite", { skip: "missing prerequisite" }, () => {',
      '  test("hidden case", () => assert.fail("must not run"));',
      "});",
      "",
    ].join("\n"),
  );
  await writeRunnerManifest(root, {
    lanes: {
      [lane]: {
        files: [
          { path, expectedTests: ["ordinary pass", "expected but skipped", "missing named case"] },
        ],
      },
    },
  });
  const { result: selected, summary } = await runCaseLane(root, lane, "case-policy");
  assert.equal(selected.status, 1, selected.stderr);
  assert.deepEqual(summary.issues.map(({ code, name, status }) => [code, name, status]).sort(), [
    ["expected-test-not-passed", "expected but skipped", "skipped"],
    ["missing-expected-test", "missing named case", undefined],
    ["unexpected-skip", "expected but skipped", "skipped"],
    ["unexpected-skip", "skipped suite", "skipped"],
    ["unexpected-skip", "todo case", "todo"],
    ["unexpected-skip", "unexpected skipped case", "skipped"],
  ]);
  assert.deepEqual(
    summary.files[0]?.tests.map(({ name, status }) => [name, status]),
    [
      ["ordinary pass", "passed"],
      ["expected but skipped", "skipped"],
      ["unexpected skipped case", "skipped"],
      ["todo case", "todo"],
    ],
  );
  const suiteSkip = summary.issues.find((entry) => entry.name === "skipped suite");
  assert.ok(suiteSkip?.source);
  assert.equal(suiteSkip.file, path);
  assert.equal(suiteSkip.source.file, suiteSkip.file);
  assert.ok(Number.isSafeInteger(suiteSkip.source.line) && suiteSkip.source.line > 0);
  assert.ok(Number.isSafeInteger(suiteSkip.source.column) && suiteSkip.source.column > 0);
  assert.equal(suiteSkip.source.nesting, 0);
  // Every issue is named in the job log, which keeps every attempt.
  for (const line of [
    `run-tests: issue missing-expected-test ${path}: expected test did not run: missing named case`,
    `run-tests: issue expected-test-not-passed ${path}: expected test did not pass: expected but skipped`,
    `run-tests: issue unexpected-skip ${path}: selected test did not run to completion: expected but skipped`,
    `run-tests: issue unexpected-skip ${path}: selected test did not run to completion: unexpected skipped case`,
    `run-tests: issue unexpected-skip ${path}: selected test did not run to completion: todo case`,
    `run-tests: issue unexpected-skip ${path}: selected suite did not run its tests: skipped suite`,
  ]) {
    assert.ok(selected.stderr.split("\n").includes(line), line);
  }

  // Filesystem traversal follows the symlink before '..'; lexical normalization
  // instead points at the unrelated in-tree helper and must not supply a source.
  const external = await temporaryDirectory(t, "ci-runner-source-");
  await mkdir(join(external, "deep"));
  await symlink(join(external, "deep"), join(root, "link"), "dir");
  await writeFile(join(root, "helper.mjs"), "// Not the source of the skipped suite.\n");
  await writeFile(
    join(external, "helper.mjs"),
    'describe("external skipped suite", { skip: true }, () => {});\n',
  );
  await writeRunnerManifest(root, {
    lanes: { [lane]: { files: [{ path, expectedTests: ["ordinary pass"] }] } },
  });
  const filenames = { absolute: `${root}/link/../helper.mjs`, relative: "link/../helper.mjs" };
  for (const [spelling, filename] of Object.entries(filenames)) {
    await writeFile(
      join(root, path),
      [
        'import { readFileSync } from "node:fs";',
        'import test, { describe } from "node:test";',
        'import { runInNewContext } from "node:vm";',
        'test("ordinary pass", () => {});',
        `const filename = ${JSON.stringify(filename)};`,
        'runInNewContext(readFileSync(filename, "utf8"), { describe }, { filename });',
      ].join("\n"),
    );
    const { result: escaped, summary: escapedSummary } = await runCaseLane(root, lane, spelling);
    assert.equal(escaped.status, 1, escaped.stderr);
    assert.equal(escapedSummary.files[0]?.nodeExitCode, 0);
    assert.deepEqual(
      escapedSummary.files[0]?.tests.map(({ name, status }) => [name, status]),
      [["ordinary pass", "passed"]],
    );
    assert.deepEqual(
      escapedSummary.issues.map(({ code, file, name, status, source }) => [
        code,
        file,
        name,
        status,
        source,
      ]),
      [["unexpected-skip", path, "external skipped suite", "skipped", undefined]],
      filename,
    );
  }
});
